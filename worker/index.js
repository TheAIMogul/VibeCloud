// VibeCloud edge Worker — static SPA host + SoundCloud CORS proxy.
//
// Replaces two Google Cloud Run services with one Cloudflare Worker:
//   1. Static assets: the built Vite SPA is served from the ASSETS binding.
//   2. CORS proxy:    /proxy?url=<encoded> forwards allow-listed SoundCloud
//                     API calls (api-v2.soundcloud.com sends no CORS headers,
//                     so the browser cannot call it cross-origin directly).
//
// This is a near-1:1 port of cors-proxy/server.js (Node http) to the Workers
// fetch/Request/Response (Web Streams) model. Audio segments, artwork,
// Pushbullet and Gemini still go DIRECT from the browser — they never touch
// this Worker — so only small JSON metadata is proxied here.
//
// Routing: wrangler.jsonc sets `run_worker_first: ["/proxy","/health"]` so
// those paths always hit this script; every other path is served as a static
// asset (with SPA fallback to index.html) without invoking the Worker.

const ALLOWED_TARGETS = [
  'api-v2.soundcloud.com',
  'api.soundcloud.com',
  'cf-media.sndcdn.com',
  'api.pushbullet.com',
];

// Hop-by-hop / identity headers we must not forward upstream (mirrors
// server.js filterHeaders, plus Cloudflare-injected request headers).
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

function isTargetAllowed(hostname) {
  return ALLOWED_TARGETS.some((t) => hostname === t || hostname.endsWith('.' + t));
}

// CORS headers. The app is same-origin with this Worker in production (so CORS
// is moot there), but we emit permissive headers so the proxy also works from
// `vite dev` on localhost and any future origin.
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

async function handleProxy(request) {
  // CORS preflight.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: applyCors(new Headers(), request) });
  }

  const incoming = new URL(request.url);
  const targetUrl = incoming.searchParams.get('url');
  if (!targetUrl) {
    return jsonError(400, 'Bad request. Usage: /proxy?url=<encoded_url>', request);
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return jsonError(400, 'Invalid url parameter', request);
  }

  if (!isTargetAllowed(target.hostname)) {
    return jsonError(403, `Target domain not allowed: ${target.hostname}`, request);
  }

  // Forward method + (for non-GET) body, with filtered headers.
  const upstreamHeaders = new Headers();
  for (const [key, value] of request.headers) {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
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

  // workerd's fetch() AUTO-DECOMPRESSES gzip/br upstream bodies but leaves the
  // stale `Content-Encoding` (and compressed `Content-Length`) headers behind.
  // Forwarding those verbatim makes the browser try to gunzip already-plaintext
  // bytes -> ERR_CONTENT_DECODING_FAILED (SoundCloud's api-v2 serves gzipped
  // JSON, and the client calls res.json() on every proxied response). So we copy
  // the headers into a mutable set, drop the encoding/length headers (letting the
  // runtime re-frame the body correctly), then layer CORS on top. The body itself
  // still STREAMS straight through — no buffering, no 128MB memory pressure.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    if (url.pathname === '/proxy') {
      return handleProxy(request);
    }

    // Fallback: serve static assets (SPA). With run_worker_first scoped to
    // /proxy and /health, normal asset/navigation requests are served by the
    // platform directly and never reach here; this is a safety net.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
