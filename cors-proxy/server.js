const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;

// Only proxy to these domains
const ALLOWED_ORIGINS = [
  'https://vibecloud.micahberkley.com',
  'https://vibecloud-soundcloud-downloader-765441234018.us-west1.run.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
];

const ALLOWED_TARGETS = [
  'api-v2.soundcloud.com',
  'api.soundcloud.com',
  'cf-media.sndcdn.com',
  'api.pushbullet.com',
];

function isTargetAllowed(hostname) {
  return ALLOWED_TARGETS.some(t => hostname === t || hostname.endsWith('.' + t));
}

function setCorsHeaders(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Access-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  // Extract target URL from query string: /proxy?url=<encoded_url>
  let targetUrl;
  try {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    targetUrl = parsed.searchParams.get('url');
    if (!targetUrl) throw new Error('Missing url parameter');
    new URL(targetUrl); // validate
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request. Usage: /proxy?url=<encoded_url>' }));
    return;
  }

  const target = new URL(targetUrl);

  if (!isTargetAllowed(target.hostname)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Target domain not allowed: ${target.hostname}` }));
    return;
  }

  // Forward the request
  const proxyReq = https.request(target.href, {
    method: req.method,
    headers: {
      ...filterHeaders(req.headers),
      host: target.host,
    },
  }, (proxyRes) => {
    setCorsHeaders(res, origin);
    // Forward status and headers (minus hop-by-hop)
    const headers = { ...proxyRes.headers };
    delete headers['transfer-encoding'];
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    setCorsHeaders(res, origin);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
  });

  // Pipe request body for POST/PUT
  req.pipe(proxyReq);
});

function filterHeaders(headers) {
  const skip = new Set(['host', 'origin', 'referer', 'cookie', 'connection']);
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

server.listen(PORT, () => {
  console.log(`CORS proxy listening on port ${PORT}`);
});
