// VibeCloud edge Worker — static SPA host + SoundCloud CORS proxy + private API.
//
// One Cloudflare Worker:
//   1. Static assets: serves the built Vite SPA via the ASSETS binding.
//   2. /proxy:        allow-listed CORS proxy to SoundCloud's API. Injects the
//                     SoundCloud client_id (a Worker secret) so it never lives
//                     in the client bundle / committed source.
//   3. /api/pb/*:     Pushbullet upload-request + push, performed server-side
//                     with a Worker secret token (so the token isn't shipped to
//                     the browser). The large file upload itself stays
//                     client-side (direct to Pushbullet's pre-signed S3 URL).
//
// Audio segments, artwork, the S3 upload, and the optional Gemini summary still
// go DIRECT from the browser — only small JSON passes through this Worker.
//
// Secrets (wrangler secret put / .dev.vars):
//   - SOUNDCLOUD_CLIENT_ID    injected into proxied SoundCloud API requests
//   - SOUNDCLOUD_OAUTH_TOKEN  injected as the `Authorization: OAuth` header on
//                             proxied SoundCloud API requests (SoundCloud now
//                             requires BOTH client_id AND an OAuth header).
//   - PUSHBULLET_TOKEN        default token for /api/pb/* (client may override)

const ALLOWED_TARGETS = [
  'api-v2.soundcloud.com',
  'api.soundcloud.com',
  'cf-media.sndcdn.com',
  'api.pushbullet.com',
];

// SoundCloud API hosts that need the client_id injected.
const SC_API_HOSTS = new Set(['api-v2.soundcloud.com', 'api.soundcloud.com']);

// Hop-by-hop / identity headers we must not forward upstream.
const SKIP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'cookie', 'connection',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
]);

function isTargetAllowed(hostname) {
  return ALLOWED_TARGETS.some((t) => hostname === t || hostname.endsWith('.' + t));
}

function applyCors(headers, request) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  const requested = request.headers.get('Access-Control-Request-Headers');
  headers.set('Access-Control-Allow-Headers', requested || 'Content-Type, Authorization, Access-Token');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

function jsonError(status, message, request) {
  const headers = applyCors(new Headers({ 'Content-Type': 'application/json' }), request);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

async function handleProxy(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: applyCors(new Headers(), request) });
  }

  const incoming = new URL(request.url);
  const targetUrl = incoming.searchParams.get('url');
  if (!targetUrl) return jsonError(400, 'Bad request. Usage: /proxy?url=<encoded_url>', request);

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return jsonError(400, 'Invalid url parameter', request);
  }

  if (!isTargetAllowed(target.hostname)) {
    return jsonError(403, `Target domain not allowed: ${target.hostname}`, request);
  }

  const isScApi = SC_API_HOSTS.has(target.hostname);

  // Inject the SoundCloud client_id server-side (kept out of the client bundle).
  if (env.SOUNDCLOUD_CLIENT_ID && isScApi) {
    target.searchParams.set('client_id', env.SOUNDCLOUD_CLIENT_ID);
  }

  const upstreamHeaders = new Headers();
  for (const [key, value] of request.headers) {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) upstreamHeaders.set(key, value);
  }

  // SoundCloud's API now requires an `Authorization: OAuth <token>` header in
  // ADDITION to the client_id query param (client_id alone returns 401). Inject
  // the token server-side from a Worker secret so it never ships to the browser.
  // A client-provided Authorization header (if any) is overridden for SC hosts.
  if (env.SOUNDCLOUD_OAUTH_TOKEN && isScApi) {
    upstreamHeaders.set('Authorization', `OAuth ${env.SOUNDCLOUD_OAUTH_TOKEN}`);
  }

  const method = request.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method,
      headers: upstreamHeaders,
      body: hasBody ? request.body : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    return jsonError(502, `Proxy error: ${err && err.message ? err.message : String(err)}`, request);
  }

  // workerd auto-decompresses gzip/br but leaves stale content-encoding/length
  // headers; forwarding them stale breaks browser decoding. Drop them; the body
  // streams straight through (no buffering).
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  applyCors(responseHeaders, request);
  responseHeaders.append('Vary', 'Origin');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

// Pushbullet calls that need the token, performed server-side with the secret.
// `body.token` is an optional per-user override; otherwise env.PUSHBULLET_TOKEN.
async function handlePushbullet(request, env, pbPath) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: applyCors(new Headers(), request) });
  }
  if (request.method !== 'POST') return jsonError(405, 'POST only', request);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON body', request);
  }

  const clientToken = (body && body.token) || '';

  let payload;
  if (pbPath === 'upload-request') {
    payload = { file_name: body.file_name, file_type: body.file_type || 'audio/mpeg' };
  } else {
    // pushes
    payload = {
      type: 'file',
      file_name: body.file_name,
      file_type: body.file_type || 'audio/mpeg',
      file_url: body.file_url,
      body: body.body || '',
    };
  }

  const endpoint = pbPath === 'upload-request'
    ? 'https://api.pushbullet.com/v2/upload-request'
    : 'https://api.pushbullet.com/v2/pushes';

  // Try the client-supplied token first; if it's missing/invalid (401/403) fall
  // back to the Worker secret so a stale token in the user's Settings never
  // breaks the push (they just get the server's default account).
  const tokens = [...new Set([clientToken, env.PUSHBULLET_TOKEN].filter(Boolean))];

  let r;
  try {
    for (const tk of tokens) {
      r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Access-Token': tk, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status !== 401 && r.status !== 403) break; // accept non-auth errors as final
    }
  } catch (err) {
    return jsonError(502, `Pushbullet error: ${err && err.message ? err.message : String(err)}`, request);
  }

  const text = await r.text();
  const headers = applyCors(new Headers({ 'Content-Type': 'application/json' }), request);
  return new Response(text, { status: r.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    if (url.pathname === '/proxy') return handleProxy(request, env);
    if (url.pathname === '/api/pb/upload-request') return handlePushbullet(request, env, 'upload-request');
    if (url.pathname === '/api/pb/push') return handlePushbullet(request, env, 'pushes');

    // Static assets (SPA). With run_worker_first scoped to these API paths,
    // normal asset/navigation requests are served by the platform directly.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
