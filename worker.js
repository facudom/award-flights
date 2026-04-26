/**
 * Award Flight Search — Cloudflare Worker proxy
 *
 * Deploy at: https://workers.cloudflare.com (free, 100k req/day)
 *
 * After deploying, replace the URL in index.html:
 *   const REMOTE_PROXY = 'https://<your-worker>.<your-name>.workers.dev/proxy/search';
 */

export default {
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', proxy: 'seats.aero' }, { headers: corsHeaders() });
    }

    if (!url.pathname.endsWith('/proxy/search')) {
      return Response.json({ error: 'Unknown route. Use /proxy/search' }, { status: 404, headers: corsHeaders() });
    }

    const apiKey = req.headers.get('X-Api-Key');
    if (!apiKey) {
      return Response.json({ error: 'Missing X-Api-Key header.' }, { status: 400, headers: corsHeaders() });
    }

    const upstream = new URL('https://seats.aero/partnerapi/search');
    url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

    let resp;
    try {
      resp = await fetch(upstream.toString(), {
        method: 'GET',
        headers: {
          'Partner-Authorization': apiKey,
          'Accept': 'application/json',
          'User-Agent': 'AwardFlightSearch/1.0',
        },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      return Response.json(
        { error: 'Proxy connection error: ' + err.message },
        { status: 502, headers: corsHeaders() }
      );
    }

    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'X-Api-Key, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}
