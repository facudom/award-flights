/**
 * Award Flight Search — Local Proxy Server (Node.js, zero dependencies)
 * Forwards browser requests to seats.aero with the Partner-Authorization header.
 *
 * Run:
 *   node proxy.js
 *
 * Then open index.html in your browser.
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = 5000;

const server = http.createServer((req, res) => {
  // Always add CORS headers so file:// pages can talk to us
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-Api-Key, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'seats.aero', node: process.version }));
    return;
  }

  if (!req.url.startsWith('/proxy/search')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown route. Use /proxy/search' }));
    return;
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing X-Api-Key header.' }));
    return;
  }

  // Forward query string as-is to seats.aero
  const parsed   = url.parse(req.url, true);
  const qs       = new URLSearchParams(parsed.query).toString();
  const apiPath  = '/partnerapi/search' + (qs ? '?' + qs : '');

  const options = {
    hostname: 'seats.aero',
    path:     apiPath,
    method:   'GET',
    headers: {
      'Partner-Authorization': apiKey,
      'Accept':                'application/json',
      'User-Agent':            'AwardFlightSearch/1.0',
    },
  };

  console.log(`[proxy] GET /partnerapi/search ${qs.slice(0, 120)}`);

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type':                  'application/json',
      'Access-Control-Allow-Origin':   '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(45_000, () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'seats.aero request timed out (45s). Try a narrower date range.' }));
    }
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy] error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy connection error: ' + err.message }));
    }
  });

  proxyReq.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ✈  Award Flight Search Proxy  (Node.js ' + process.version + ')');
  console.log('  ' + '─'.repeat(42));
  console.log('  Listening:   http://localhost:5000');
  console.log('  Health:      http://localhost:5000/health');
  console.log('  ' + '─'.repeat(42));
  console.log('  Open index.html in your browser to start searching.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
