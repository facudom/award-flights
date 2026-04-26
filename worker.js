/**
 * Award Flight Search — Cloudflare Worker
 * - Proxies seats.aero API requests
 * - Telegram auth: user sends code to bot → verified chatId stored per user
 * - Stores/manages alerts per user in KV
 * - Runs daily cron to check alerts and notify per-user via Telegram
 * - Bot commands: /list, /stop <n>, /stopall
 */

const TELEGRAM_TOKEN = '8629994415:AAHu9h0cDSAs8adnvSMq_93wrpKTzNzmCVo';
const BOT_USERNAME   = 'CanjesMillasBot';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: cors() });
    }

    // ── Telegram webhook (bot receives messages) ──
    if (url.pathname === '/telegram-webhook') {
      return handleTelegramWebhook(req, env);
    }

    // ── Auth: generate a verification code ──
    if (url.pathname === '/auth/code' && req.method === 'POST') {
      return handleGenerateCode(req, env);
    }

    // ── Auth: poll for verification status ──
    if (url.pathname === '/auth/poll') {
      return handlePollAuth(url, env);
    }

    // ── Alerts CRUD ──
    if (url.pathname === '/alerts') {
      if (req.method === 'GET')    return handleGetAlerts(url, env);
      if (req.method === 'POST')   return handleSaveAlert(req, env);
      if (req.method === 'DELETE') return handleDeleteAlert(url, env);
    }

    // ── Manual cron trigger ──
    if (url.pathname === '/run-alerts') {
      await checkAlerts(env);
      return Response.json({ status: 'done' }, { headers: cors() });
    }

    if (!url.pathname.endsWith('/proxy/search')) {
      return Response.json({ error: 'Unknown route.' }, { status: 404, headers: cors() });
    }

    return handleSearch(req, url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAlerts(env));
  },
};

// ── Proxy ────────────────────────────────────────────────────────
async function handleSearch(req, url) {
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
  return new Response(body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

// ── Auth: generate code ──────────────────────────────────────────
async function handleGenerateCode(req, env) {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase(); // e.g. "A3X9KZ"
  // Store with 2-minute TTL
  await env.ALERTS_KV.put(`code:${code}`, JSON.stringify({ verified: false }), { expirationTtl: 120 });
  return Response.json({ code, bot: BOT_USERNAME }, { headers: cors() });
}

// ── Auth: poll for verification ──────────────────────────────────
async function handlePollAuth(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return Response.json({ error: 'Missing code' }, { status: 400, headers: cors() });

  const raw = await env.ALERTS_KV.get(`code:${code}`);
  if (!raw) return Response.json({ status: 'expired' }, { headers: cors() });

  const data = JSON.parse(raw);
  if (data.verified) {
    return Response.json({ status: 'verified', chatId: data.chatId, username: data.username }, { headers: cors() });
  }
  return Response.json({ status: 'pending' }, { headers: cors() });
}

// ── Telegram webhook ─────────────────────────────────────────────
async function handleTelegramWebhook(req, env) {
  let body;
  try { body = await req.json(); } catch { return new Response('ok'); }

  const msg = body.message || body.edited_message;
  if (!msg || !msg.text) return new Response('ok');

  const chatId  = String(msg.chat.id);
  const username = msg.from?.username || msg.from?.first_name || 'unknown';
  const text    = msg.text.trim();

  // ── Bot commands ──
  if (text.startsWith('/list')) {
    const raw = await env.ALERTS_KV.get(`alerts:${chatId}`);
    const alerts = raw ? JSON.parse(raw) : [];
    if (!alerts.length) {
      await sendTelegram(chatId, '📭 You have no active alerts.');
    } else {
      const lines = alerts.map((a, i) =>
        `${i+1}. ${a.origin}→${a.destinations.join(',')} | ${a.startDate}→${a.endDate} | <${a.maxMiles.toLocaleString('en-US')} mi (${a.cabin})`
      ).join('\n');
      await sendTelegram(chatId, `📋 Your alerts:\n\n${lines}\n\nUse /stop N to remove one, or /stopall to remove all.`);
    }
    return new Response('ok');
  }

  if (text.startsWith('/stopall')) {
    await env.ALERTS_KV.put(`alerts:${chatId}`, JSON.stringify([]));
    await sendTelegram(chatId, '🛑 All your alerts have been removed.');
    return new Response('ok');
  }

  if (text.startsWith('/stop ')) {
    const n = parseInt(text.slice(6).trim(), 10);
    const raw = await env.ALERTS_KV.get(`alerts:${chatId}`);
    const alerts = raw ? JSON.parse(raw) : [];
    if (isNaN(n) || n < 1 || n > alerts.length) {
      await sendTelegram(chatId, `❌ Invalid number. Use /list to see your alerts.`);
    } else {
      const removed = alerts.splice(n - 1, 1)[0];
      await env.ALERTS_KV.put(`alerts:${chatId}`, JSON.stringify(alerts));
      await sendTelegram(chatId, `✅ Removed alert: ${removed.origin}→${removed.destinations.join(',')}`);
    }
    return new Response('ok');
  }

  // ── Verification code ──
  const codeMatch = text.match(/^[A-Z0-9]{6}$/);
  if (codeMatch) {
    const raw = await env.ALERTS_KV.get(`code:${text}`);
    if (!raw) {
      await sendTelegram(chatId, '❌ Code not found or expired. Please generate a new one in the app.');
    } else {
      const data = JSON.parse(raw);
      data.verified = true;
      data.chatId   = chatId;
      data.username = username;
      // Keep verified code for 60s so the browser can pick it up
      await env.ALERTS_KV.put(`code:${text}`, JSON.stringify(data), { expirationTtl: 60 });
      await sendTelegram(chatId, `✅ Verified! You're connected as @${username}.\n\nYou can now create alerts in the app. To manage alerts later, use:\n/list — see your alerts\n/stop N — remove alert N\n/stopall — remove all alerts`);
    }
    return new Response('ok');
  }

  // Default reply
  await sendTelegram(chatId, `👋 Hi! Use the app to create alerts:\nhttps://facudom.github.io/award-flights/\n\nOr use:\n/list — your alerts\n/stop N — remove alert N\n/stopall — remove all`);
  return new Response('ok');
}

// ── Alerts CRUD ──────────────────────────────────────────────────
async function handleGetAlerts(url, env) {
  const chatId = url.searchParams.get('chatId');
  if (!chatId) return Response.json({ error: 'Missing chatId' }, { status: 400, headers: cors() });
  const raw = await env.ALERTS_KV.get(`alerts:${chatId}`);
  return Response.json(raw ? JSON.parse(raw) : [], { headers: cors() });
}

async function handleSaveAlert(req, env) {
  const alert = await req.json();
  if (!alert.chatId) return Response.json({ error: 'Missing chatId' }, { status: 400, headers: cors() });

  alert.id      = crypto.randomUUID();
  alert.created = new Date().toISOString();

  const raw    = await env.ALERTS_KV.get(`alerts:${alert.chatId}`);
  const alerts = raw ? JSON.parse(raw) : [];
  alerts.push(alert);
  await env.ALERTS_KV.put(`alerts:${alert.chatId}`, JSON.stringify(alerts));

  // Immediate check (fire and forget)
  const apiKey = await env.ALERTS_KV.get('seatsaero_key');
  if (apiKey) checkAlert(alert, apiKey, '🔍').catch(() => {});

  // Confirmation
  const msg = `✅ Alert created!\n\n` +
    `📍 ${alert.origin} → ${alert.destinations.join(', ')}\n` +
    `📅 ${alert.startDate} → ${alert.endDate}\n` +
    `✈️ ${alert.cabin} · max ${Number(alert.maxMiles).toLocaleString('en-US')} mi\n\n` +
    `Checking daily at 8am. Use /list or /stopall to manage.`;
  await sendTelegram(alert.chatId, msg);

  return Response.json({ ok: true, id: alert.id }, { headers: cors() });
}

async function handleDeleteAlert(url, env) {
  const id     = url.searchParams.get('id');
  const chatId = url.searchParams.get('chatId');
  if (!chatId) return Response.json({ error: 'Missing chatId' }, { status: 400, headers: cors() });

  const raw    = await env.ALERTS_KV.get(`alerts:${chatId}`);
  const alerts = raw ? JSON.parse(raw) : [];
  await env.ALERTS_KV.put(`alerts:${chatId}`, JSON.stringify(alerts.filter(a => a.id !== id)));
  return Response.json({ ok: true }, { headers: cors() });
}

// ── Daily checker ────────────────────────────────────────────────
async function checkAlerts(env) {
  const apiKey = await env.ALERTS_KV.get('seatsaero_key');
  if (!apiKey) return;

  // List all alert keys
  const list = await env.ALERTS_KV.list({ prefix: 'alerts:' });
  for (const key of list.keys) {
    const raw = await env.ALERTS_KV.get(key.name);
    const alerts = raw ? JSON.parse(raw) : [];
    for (const alert of alerts) {
      await checkAlert(alert, apiKey, '🚨');
    }
  }
}

async function checkAlert(alert, apiKey, prefix = '🚨') {
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
        headers: { 'Partner-Authorization': apiKey, 'Accept': 'application/json', 'User-Agent': 'AwardFlightSearch/1.0' },
        signal: AbortSignal.timeout(45_000),
      });
      const data = await resp.json();
      for (const r of (data.data || data.results || [])) {
        const src = r.Source || r.Route?.Source || '';
        if (alert.programs.length && !alert.programs.includes(src)) continue;
        const cost = alert.cabin === 'business' ? r.JMileageCostRaw : alert.cabin === 'economy' ? r.YMileageCostRaw : r.WMileageCostRaw;
        if (cost > 0 && cost <= alert.maxMiles) hits.push({ dest, src, miles: cost, date: r.Date, direct: r.JDirect });
      }
    } catch (e) { /* skip */ }
  }

  const chatId = alert.chatId;
  if (!chatId) return;

  if (hits.length) {
    hits.sort((a, b) => a.miles - b.miles);
    const lines = hits.slice(0, 10).map(h =>
      `  • ${h.date.slice(0,10)} ${alert.origin}→${h.dest} via ${h.src}: ${h.miles.toLocaleString('en-US')} mi${h.direct ? ' ✈ direct' : ''}`
    ).join('\n');
    await sendTelegram(chatId,
      `${prefix} ${alert.origin} → ${alert.destinations.join('/')}\n\n` +
      `${hits.length} option${hits.length>1?'s':''} under ${Number(alert.maxMiles).toLocaleString('en-US')} mi:\n\n${lines}` +
      `${hits.length > 10 ? `\n  ...and ${hits.length-10} more` : ''}\n\n👉 https://facudom.github.io/award-flights/`
    );
  } else if (prefix === '🔍') {
    await sendTelegram(chatId, `🔍 No availability yet for ${alert.origin}→${alert.destinations.join(',')} under ${Number(alert.maxMiles).toLocaleString('en-US')} mi. Checking daily.`);
  }
}

// ── Telegram ─────────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
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
