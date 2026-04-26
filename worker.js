/**
 * Award Flight Search — Cloudflare Worker
 * - Proxies seats.aero API requests
 * - Stores/manages alerts in KV
 * - Runs daily cron to check alerts and notify via Telegram
 */

const TELEGRAM_TOKEN = '8629994415:AAHu9h0cDSAs8adnvSMq_93wrpKTzNzmCVo';
const TELEGRAM_CHAT_ID = '76588765';

export default {
  // ── HTTP handler ──────────────────────────────────────────────
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', proxy: 'seats.aero' }, { headers: cors() });
    }

    // Alerts CRUD
    if (url.pathname === '/alerts') {
      if (req.method === 'GET')    return handleGetAlerts(env);
      if (req.method === 'POST')   return handleSaveAlert(req, env);
      if (req.method === 'DELETE') return handleDeleteAlert(url, env);
    }

    // Manual cron trigger for testing
    if (url.pathname === '/run-alerts') {
      await checkAlerts(env);
      return Response.json({ status: 'done' }, { headers: cors() });
    }

    if (!url.pathname.endsWith('/proxy/search')) {
      return Response.json({ error: 'Unknown route.' }, { status: 404, headers: cors() });
    }

    return handleSearch(req, url, env);
  },

  // ── Cron handler (runs daily) ─────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAlerts(env));
  },
};

// ── Proxy ────────────────────────────────────────────────────────
async function handleSearch(req, url, env) {
  const apiKey = req.headers.get('X-Api-Key');
  if (!apiKey) return Response.json({ error: 'Missing X-Api-Key header.' }, { status: 400, headers: cors() });

  const upstream = new URL('https://seats.aero/partnerapi/search');
  url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

  let resp;
  try {
    resp = await fetch(upstream.toString(), {
      headers: {
        'Partner-Authorization': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'AwardFlightSearch/1.0',
      },
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    return Response.json({ error: 'Proxy error: ' + err.message }, { status: 502, headers: cors() });
  }

  const body = await resp.arrayBuffer();
  return new Response(body, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

// ── Alerts CRUD ──────────────────────────────────────────────────
async function handleGetAlerts(env) {
  const raw = await env.ALERTS_KV.get('alerts');
  const alerts = raw ? JSON.parse(raw) : [];
  return Response.json(alerts, { headers: cors() });
}

async function handleSaveAlert(req, env) {
  const alert = await req.json();
  alert.id = crypto.randomUUID();
  alert.created = new Date().toISOString();

  const raw = await env.ALERTS_KV.get('alerts');
  const alerts = raw ? JSON.parse(raw) : [];
  alerts.push(alert);
  await env.ALERTS_KV.put('alerts', JSON.stringify(alerts));

  // Send confirmation via Telegram
  const dests = alert.destinations.join(', ');
  const msg = `✅ Alert created!\n\n` +
    `📍 Route: ${alert.origin} → ${dests}\n` +
    `📅 Dates: ${alert.startDate} → ${alert.endDate}\n` +
    `✈️ Cabin: ${alert.cabin}\n` +
    `🎯 Max miles: ${Number(alert.maxMiles).toLocaleString('en-US')}\n` +
    `💳 Programs: ${alert.programs.join(', ')}\n\n` +
    `I'll check daily and notify you when availability drops below your threshold.`;
  await sendTelegram(msg);

  return Response.json({ ok: true, id: alert.id }, { headers: cors() });
}

async function handleDeleteAlert(url, env) {
  const id = url.searchParams.get('id');
  const raw = await env.ALERTS_KV.get('alerts');
  const alerts = raw ? JSON.parse(raw) : [];
  const filtered = alerts.filter(a => a.id !== id);
  await env.ALERTS_KV.put('alerts', JSON.stringify(filtered));
  return Response.json({ ok: true }, { headers: cors() });
}

// ── Daily alert checker ──────────────────────────────────────────
async function checkAlerts(env) {
  const apiKey = await env.ALERTS_KV.get('seatsaero_key');
  if (!apiKey) {
    await sendTelegram('⚠️ Alert check failed: no Seats.aero API key stored. Open the app and save your key.');
    return;
  }

  const raw = await env.ALERTS_KV.get('alerts');
  const alerts = raw ? JSON.parse(raw) : [];
  if (!alerts.length) return;

  for (const alert of alerts) {
    const hits = [];

    for (const dest of alert.destinations) {
      const params = new URLSearchParams({
        origin_airport:      alert.origin,
        destination_airport: dest,
        start_date:          alert.startDate,
        end_date:            alert.endDate,
        take:                '1000',
      });

      try {
        const resp = await fetch(`https://seats.aero/partnerapi/search?${params}`, {
          headers: {
            'Partner-Authorization': apiKey,
            'Accept': 'application/json',
            'User-Agent': 'AwardFlightSearch/1.0',
          },
          signal: AbortSignal.timeout(45_000),
        });
        const data = await resp.json();
        const rows = data.data || data.results || [];

        for (const r of rows) {
          const src = r.Source || r.Route?.Source || '';
          if (alert.programs.length && !alert.programs.includes(src)) continue;

          const cabinCost = alert.cabin === 'business' ? r.JMileageCostRaw
            : alert.cabin === 'economy' ? r.YMileageCostRaw
            : r.WMileageCostRaw;

          if (cabinCost > 0 && cabinCost <= alert.maxMiles) {
            hits.push({ dest, src, miles: cabinCost, date: r.Date, direct: r.JDirect });
          }
        }
      } catch (e) {
        // skip this dest on error
      }
    }

    if (hits.length) {
      // Sort by miles asc
      hits.sort((a, b) => a.miles - b.miles);
      const lines = hits.slice(0, 10).map(h =>
        `  • ${h.date.slice(0,10)} ${alert.origin}→${h.dest} via ${h.src}: ${h.miles.toLocaleString('en-US')} mi${h.direct ? ' ✈ direct' : ''}`
      ).join('\n');

      const msg = `🚨 Alert hit! ${alert.origin} → ${alert.destinations.join('/')}\n\n` +
        `${hits.length} option${hits.length>1?'s':''} under ${Number(alert.maxMiles).toLocaleString('en-US')} miles:\n\n` +
        `${lines}${hits.length > 10 ? `\n  ...and ${hits.length-10} more` : ''}\n\n` +
        `👉 https://facudom.github.io/award-flights/`;
      await sendTelegram(msg);
    }
  }
}

// ── Telegram ─────────────────────────────────────────────────────
async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
}

// ── CORS ─────────────────────────────────────────────────────────
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'X-Api-Key, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
}
