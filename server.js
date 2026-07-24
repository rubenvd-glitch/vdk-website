// VDK Business Services — website + 2FA admin panel (Base) + separate CRM service
// Zero dependencies: runs with plain Node.js (v18+). Start with: node server.js
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

// ---------- .env loader ----------
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'info@vdkbusiness-services.nl').toLowerCase();
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours — log in once per day
const CODE_TTL = 10 * 60 * 1000; // 10 minutes

// CRM: fixed sector list for company categorization.
const CRM_SECTORS = [
  'Horeca', 'Sport & Fitness', 'Financien & Verzekeringen', 'Vastgoed & Makelaardij',
  'Bouw & Techniek', 'Detailhandel & Retail', 'Zorg & Welzijn', 'Onderwijs',
  'Automotive & Transport', 'Media & Marketing', 'ICT & Technologie',
  'Zakelijke Dienstverlening', 'Overheid & Non-profit', 'Evenementen & Cultuur',
  'Voeding & Drank', 'Reizen & Vrije Tijd', 'Overig',
];

// ---------- Minimal SMTP client (STARTTLS on 587 or implicit TLS on 465) ----------
function smtpConfigured() {
  return !!process.env.RESEND_API_KEY ||
    !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// Preferred: Resend HTTPS API (Render's free tier blocks SMTP ports).
function sendViaResend({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const from = process.env.MAIL_FROM || 'onboarding@resend.dev';
    const payload = JSON.stringify({
      from: `VDK Business Services <${from}>`,
      to: [to],
      subject,
      text,
    });
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          reject(new Error(`Resend API ${res.statusCode}: ${body}`));
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Resend API timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendMail(mail) {
  if (process.env.RESEND_API_KEY) return sendViaResend(mail);
  return sendViaSmtp(mail);
}

// Fallback: raw SMTP (works on hosts that allow ports 465/587, e.g. a VPS).
function sendViaSmtp({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 465);
    const startWithTls = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = process.env.SMTP_USER;
    const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
    const from = process.env.MAIL_FROM || user;

    let socket;
    let settled = false;
    let buffer = '';
    let stage = 'greeting';

    const done = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      err ? reject(err) : resolve();
    };
    const write = (line) => socket.write(line + '\r\n');

    const message = [
      `From: VDK Business Services <${from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@vdkbusiness-services.nl>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      text.replace(/\r?\n/g, '\r\n'),
    ].join('\r\n');

    // Advance the SMTP conversation based on the reply code + current stage.
    function handle(code, fullReply) {
      switch (stage) {
        case 'greeting':
          if (code !== 220) return done(new Error(`greeting failed: ${fullReply}`));
          stage = 'ehlo'; write('EHLO vdkbusiness-services.nl'); break;
        case 'ehlo':
          if (code !== 250) return done(new Error(`EHLO failed: ${fullReply}`));
          stage = 'auth'; write('AUTH LOGIN'); break;
        case 'auth':
          if (code !== 334) return done(new Error(`AUTH LOGIN failed: ${fullReply}`));
          stage = 'user'; write(Buffer.from(user).toString('base64')); break;
        case 'user':
          if (code !== 334) return done(new Error(`username rejected: ${fullReply}`));
          stage = 'pass'; write(Buffer.from(pass).toString('base64')); break;
        case 'pass':
          if (code !== 235) return done(new Error(`login rejected: ${fullReply}`));
          stage = 'mailfrom'; write(`MAIL FROM:<${from}>`); break;
        case 'mailfrom':
          if (code !== 250) return done(new Error(`MAIL FROM failed: ${fullReply}`));
          stage = 'rcpt'; write(`RCPT TO:<${to}>`); break;
        case 'rcpt':
          if (code !== 250) return done(new Error(`RCPT TO failed: ${fullReply}`));
          stage = 'data'; write('DATA'); break;
        case 'data':
          if (code !== 354) return done(new Error(`DATA failed: ${fullReply}`));
          stage = 'body'; socket.write(message + '\r\n.\r\n'); break;
        case 'body':
          if (code !== 250) return done(new Error(`message rejected: ${fullReply}`));
          stage = 'quit'; write('QUIT'); done(); break;
      }
    }

    function onData(chunk) {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // Continuation lines look like "250-...", the final line "250 ..."
        if (!/^\d{3} /.test(line)) continue;
        handle(Number(line.slice(0, 3)), line);
      }
    }

    const connectOpts = { host, port };
    if (startWithTls) connectOpts.servername = host;
    socket = startWithTls
      ? tls.connect({ ...connectOpts, servername: host })
      : net.connect(connectOpts);
    socket.setTimeout(20000, () => done(new Error('SMTP timeout')));
    socket.on('data', onData);
    socket.on('error', (e) => done(e instanceof Error ? e : new Error(String(e))));
    socket.on('end', () => done(new Error('connection closed by server')));
  });
}

// ---------- Key-value storage (Upstash Redis REST API over HTTPS) ----------
const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvCmd(...cmd) {
  if (!KV_URL || !KV_TOKEN) throw new Error('storage not configured');
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const d = await r.json();
  if (d.error) throw new Error(`KV error: ${d.error}`);
  return d.result;
}
const kvGetJson = async (k) => { const v = await kvCmd('GET', k); return v ? JSON.parse(v) : null; };
const kvSetJson = (k, obj) => kvCmd('SET', k, JSON.stringify(obj));

// ---------- Analytics + event log (fire-and-forget, never blocks a request) ----------
const statDay = () => new Date().toISOString().slice(0, 10);

function bump(k) {
  if (!KV_URL) return;
  const key = `st:${statDay()}:${k}`;
  kvCmd('INCR', key).then(() => kvCmd('EXPIRE', key, '2678400')).catch(() => {});
}
function bumpUniq(ip) {
  if (!KV_URL) return;
  const h = crypto.createHash('sha256').update(`${ip}|vdk`).digest('hex').slice(0, 16);
  const key = `st:${statDay()}:u`;
  kvCmd('PFADD', key, h).then(() => kvCmd('EXPIRE', key, '2678400')).catch(() => {});
}
function logEvent(type, msg) {
  if (!KV_URL) return;
  kvCmd('LPUSH', 'log', JSON.stringify({ t: Date.now(), type, msg }))
    .then(() => kvCmd('LTRIM', 'log', '0', '299'))
    .catch(() => {});
}

// ---------- Telegram ----------
async function tgSend(text) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token || !KV_URL) return false;
  try {
    const chat = await kvCmd('GET', 'tg:chat');
    if (!chat) return false;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    return r.ok;
  } catch (e) {
    console.error('telegram send failed:', e.message);
    return false;
  }
}

async function weeklySummaryText() {
  const get = async (d, k) => Number(await kvCmd('GET', `st:${d}:${k}`).catch(() => 0)) || 0;
  const getUniq = async (d) => Number(await kvCmd('PFCOUNT', `st:${d}:u`).catch(() => 0)) || 0;
  let totalV = 0, totalU = 0, totalL = 0, totalRc = 0, totalRd = 0, totalId = 0;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - i);
    const d = dt.toISOString().slice(0, 10);
    const [v, u, l, rc, rd, id] = await Promise.all([get(d, 'v'), getUniq(d), get(d, 'l'), get(d, 'rc'), get(d, 'rd'), get(d, 'id')]);
    totalV += v; totalU += u; totalL += l; totalRc += rc; totalRd += rd; totalId += id;
    days.push(`${d}: ${v} bezoeken, ${u} uniek, ${l} logins`);
  }
  const first = new Date(); first.setUTCDate(first.getUTCDate() - 6);
  const range = `${first.toISOString().slice(0, 10)} t/m ${new Date().toISOString().slice(0, 10)}`;
  const lines = [
    `Weekoverzicht (${range})`,
    ``,
    `Website: ${totalV} bezoeken, ${totalU} unieke bezoekers (som per dag)`,
    `Logins: ${totalL}`,
    `Reminders: ${totalRc} aangemaakt, ${totalRd} afgerond`,
    `Ideeën gedropt: ${totalId}`,
    ``,
    `Per dag:`,
    ...days,
  ];
  return lines.join('\n');
}

async function dailySummaryText() {
  const d = statDay();
  const get = async (k) => Number(await kvCmd('GET', `st:${d}:${k}`).catch(() => 0)) || 0;
  const uniq = Number(await kvCmd('PFCOUNT', `st:${d}:u`).catch(() => 0)) || 0;
  const [v, l, rc, rd, id] = await Promise.all([get('v'), get('l'), get('rc'), get('rd'), get('id')]);
  let logins = [];
  try {
    const raw = (await kvCmd('LRANGE', 'log', '0', '99')) || [];
    const dayStart = new Date(d + 'T00:00:00Z').getTime();
    logins = raw.map((x) => JSON.parse(x))
      .filter((e) => e.type === 'login' && e.t >= dayStart)
      .map((e) => e.msg);
    logins = [...new Set(logins)];
  } catch (e) { /* ignore */ }
  const lines = [
    `Dagoverzicht ${d}`,
    ``,
    `Website: ${v} bezoeken, ${uniq} unieke bezoekers`,
    `Logins: ${l}${logins.length ? ` (${logins.join(', ')})` : ''}`,
    `Reminders: ${rc} aangemaakt, ${rd} afgerond`,
    `Ideeën gedropt: ${id}`,
  ];
  return lines.join('\n');
}

// ---------- Sessions (HMAC-signed cookie, in-memory store) ----------
// Two independent realms: "admin" (Base panel) and "crm" (CRM, fully separate
// login/session — logging into one does NOT log you into the other).
const sessionStores = { admin: new Map(), crm: new Map() };
const REALM_COOKIE = { admin: 'vdk_sid', crm: 'vdk_crm_sid' };

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSession(realm, email) {
  const id = crypto.randomBytes(24).toString('base64url');
  sessionStores[realm].set(id, { email, expires: Date.now() + SESSION_TTL });
  return `${id}.${sign(id)}`;
}

function getSession(req, realm) {
  const cookieName = REALM_COOKIE[realm];
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  const raw = cookies[cookieName];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(id);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const store = sessionStores[realm];
  const s = store.get(id);
  if (!s || Date.now() > s.expires) { store.delete(id); return null; }
  return { id, ...s };
}

function sessionCookie(realm, value, maxAgeMs) {
  const parts = [
    `${REALM_COOKIE[realm]}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

// ---------- 2FA codes + rate limiting (in-memory) ----------
// Namespaced per realm so a Base code and a CRM code never collide.
const codes = new Map(); // "realm:email" -> { hash, expires, attempts }
const rateLimit = new Map(); // ip -> { count, resetAt }

const hashCode = (c) => crypto.createHash('sha256').update(c).digest('hex');

// Login codes survive restarts by living in KV (10 min TTL); memory is the dev fallback.
async function getLoginCode(realm, email) {
  const key = `${realm}:${email}`;
  if (KV_URL) {
    try { const v = await kvCmd('GET', `code:${key}`); return v ? JSON.parse(v) : null; }
    catch (e) { console.error('code get failed:', e.message); return null; }
  }
  const entry = codes.get(key);
  if (!entry || Date.now() > entry.expires) { codes.delete(key); return null; }
  return entry;
}
async function saveLoginCode(realm, email, entry) {
  const key = `${realm}:${email}`;
  if (KV_URL) {
    try { await kvCmd('SET', `code:${key}`, JSON.stringify(entry), 'EX', '600'); return; }
    catch (e) { console.error('code save failed:', e.message); }
  }
  codes.set(key, { ...entry, expires: Date.now() + CODE_TTL });
}
async function delLoginCode(realm, email) {
  const key = `${realm}:${email}`;
  if (KV_URL) { try { await kvCmd('DEL', `code:${key}`); } catch (e) { /* ignore */ } }
  codes.delete(key);
}

function allowRate(ip) {
  const now = Date.now();
  const e = rateLimit.get(ip);
  if (!e || now > e.resetAt) { rateLimit.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); return true; }
  return ++e.count <= 10;
}

// ---------- HTTP helpers ----------
function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

function serveFile(res, filePath, status = 200) {
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.css': 'text/css', '.js': 'text/javascript', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(status, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// Shared 2FA request/verify handlers, parameterized by realm so Base and the
// CRM never share a login state.
async function handleRequestCode(req, res, realm) {
  if (!allowRate(req.socket.remoteAddress)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If this email is authorized, a code has been sent.' };
  let allowed = email === ADMIN_EMAIL && email.includes('@');
  if (realm === 'admin' && !allowed && email.includes('@') && KV_URL) {
    try {
      if (await kvGetJson(`user:${email}`)) allowed = true;
      else {
        const st = await kvGetJson('settings');
        if (st && st.lockedToAdmin === false) allowed = true;
      }
    } catch (e) { console.error('KV check failed:', e.message); }
  }
  if (realm === 'crm' && !allowed && email.includes('@') && KV_URL) {
    try {
      if (await kvGetJson(`crmuser:${email}`)) allowed = true;
      else {
        const st = await kvGetJson('settings');
        if (st && st.lockedCrmToAdmin === false) allowed = true;
      }
    } catch (e) { console.error('KV check failed:', e.message); }
  }
  if (!allowed) return json(res, 200, generic);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await saveLoginCode(realm, email, { hash: hashCode(code), attempts: 0 });

  const subjectApp = realm === 'crm' ? 'VDK CRM' : 'VDK Base';
  if (smtpConfigured()) {
    try {
      await sendMail({
        to: email,
        subject: `Your ${subjectApp} login code: ${code}`,
        text: `Your login code for ${subjectApp} is: ${code}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`,
      });
    } catch (err) {
      console.error('SMTP send failed:', (err && (err.stack || err.message)) || String(err));
      return json(res, 500, { error: 'Could not send email. Check SMTP settings.' });
    }
  } else {
    console.log(`[DEV] No SMTP configured. Login code for ${realm}:${email}: ${code}`);
  }
  return json(res, 200, generic);
}

async function handleVerify(req, res, realm) {
  if (!allowRate(req.socket.remoteAddress)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const entry = await getLoginCode(realm, email);
  if (!entry) {
    return json(res, 401, { error: 'Code ongeldig of verlopen. Vraag een nieuwe aan.' });
  }
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts > 5) {
    await delLoginCode(realm, email);
    return json(res, 401, { error: 'Te vaak fout. Vraag een nieuwe code aan.' });
  }
  await saveLoginCode(realm, email, entry);
  const ok = crypto.timingSafeEqual(Buffer.from(hashCode(code)), Buffer.from(entry.hash));
  if (!ok) return json(res, 401, { error: 'Code klopt niet. Probeer opnieuw.' });
  await delLoginCode(realm, email);

  if (realm === 'admin' && email !== ADMIN_EMAIL && KV_URL) {
    try {
      if (!(await kvGetJson(`user:${email}`))) {
        const st = await kvGetJson('settings');
        if (!st || st.lockedToAdmin !== false) {
          logEvent('geweigerd', email);
          return json(res, 403, { error: 'Dit e-mailadres heeft geen toegang tot dit paneel.' });
        }
        await kvSetJson(`user:${email}`, { createdAt: Date.now() });
        logEvent('nieuw account', email);
        tgSend(`Nieuw account aangemaakt in je VDK-paneel: ${email}`).catch(() => {});
      }
    } catch (e) {
      console.error('KV user create failed:', e.message);
      return json(res, 500, { error: 'Storage unavailable.' });
    }
  }
  if (realm === 'crm' && email !== ADMIN_EMAIL && KV_URL) {
    try {
      if (!(await kvGetJson(`crmuser:${email}`))) {
        const st = await kvGetJson('settings');
        if (!st || st.lockedCrmToAdmin !== false) {
          logEvent('geweigerd (crm)', email);
          return json(res, 403, { error: 'Dit e-mailadres heeft geen toegang tot het CRM.' });
        }
        await kvSetJson(`crmuser:${email}`, { createdAt: Date.now() });
        logEvent('nieuw crm account', email);
        tgSend(`Nieuw CRM-account aangemaakt: ${email}`).catch(() => {});
      }
    } catch (e) {
      console.error('KV crm user create failed:', e.message);
      return json(res, 500, { error: 'Storage unavailable.' });
    }
  }
  if (realm === 'admin') {
    bump('l');
    logEvent('login', email);
    if (email !== ADMIN_EMAIL) tgSend(`Login op je VDK-paneel: ${email}`).catch(() => {});
  }
  const cookie = createSession(realm, email);
  return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(realm, cookie, SESSION_TTL) });
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  // --- Base auth API ---
  if (req.method === 'POST' && p === '/base/request-code') return handleRequestCode(req, res, 'admin');
  if (req.method === 'POST' && p === '/base/verify') return handleVerify(req, res, 'admin');
  if (req.method === 'POST' && p === '/base/logout') {
    const s = getSession(req, 'admin');
    if (s) sessionStores.admin.delete(s.id);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('admin', '', 0) });
  }

  // --- CRM auth API (fully separate from Base) ---
  if (req.method === 'POST' && p === '/crm/request-code') return handleRequestCode(req, res, 'crm');
  if (req.method === 'POST' && p === '/crm/verify') return handleVerify(req, res, 'crm');
  if (req.method === 'POST' && p === '/crm/logout') {
    const s = getSession(req, 'crm');
    if (s) sessionStores.crm.delete(s.id);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('crm', '', 0) });
  }

  // --- Panel API (Base) ---
  if (p === '/api/me') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    return json(res, 200, { email: s.email, isAdmin: s.email === ADMIN_EMAIL });
  }

  // --- CRM API ---
  if (p === '/api/crm/me') {
    const s = getSession(req, 'crm');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    return json(res, 200, { email: s.email, isAdmin: s.email === ADMIN_EMAIL });
  }

  if (p === '/api/crm/companies') {
    const s = getSession(req, 'crm');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    const key = `crmco:${s.email}`;
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
      if (req.method === 'POST') {
        const body = await readBody(req);
        let list = (await kvGetJson(key)) || [];
        if (body.action === 'create') {
          const name = String(body.name || '').trim().slice(0, 200);
          if (!name) return json(res, 400, { error: 'Bedrijfsnaam is verplicht' });
          const co = {
            id: crypto.randomUUID(),
            name,
            status: ['lead', 'prospect', 'klant', 'inactief'].includes(body.status) ? body.status : 'lead',
            approached: !!body.approached,
            sector: CRM_SECTORS.includes(body.sector) ? body.sector : '',
            contacts: [],
            createdAt: Date.now(),
          };
          // Optional contact person supplied at company-creation time (e.g. when
          // creating a new action for a company that doesn't exist yet).
          if (body.contact && String(body.contact.name || '').trim()) {
            co.contacts.push({
              id: crypto.randomUUID(),
              name: String(body.contact.name).trim().slice(0, 200),
              email: String(body.contact.email || '').trim().slice(0, 200),
              phone: String(body.contact.phone || '').trim().slice(0, 60),
            });
          }
          list.push(co);
          await kvSetJson(key, list);
          return json(res, 200, { ok: true, companies: list, company: co });
        }
        const co = list.find((x) => x.id === body.id);
        if (body.action === 'update') {
          if (!co) return json(res, 404, { error: 'Niet gevonden' });
          if (body.name !== undefined) co.name = String(body.name).trim().slice(0, 200) || co.name;
          if (body.status !== undefined) co.status = ['lead', 'prospect', 'klant', 'inactief'].includes(body.status) ? body.status : co.status;
          if (body.approached !== undefined) co.approached = !!body.approached;
          if (body.sector !== undefined) co.sector = CRM_SECTORS.includes(body.sector) ? body.sector : '';
        } else if (body.action === 'contact-add') {
          if (!co) return json(res, 404, { error: 'Niet gevonden' });
          const name = String((body.contact && body.contact.name) || '').trim().slice(0, 200);
          if (!name) return json(res, 400, { error: 'Naam contactpersoon is verplicht' });
          if (!co.contacts) co.contacts = [];
          co.contacts.push({
            id: crypto.randomUUID(),
            name,
            email: String((body.contact && body.contact.email) || '').trim().slice(0, 200),
            phone: String((body.contact && body.contact.phone) || '').trim().slice(0, 60),
          });
        } else if (body.action === 'contact-update') {
          if (!co) return json(res, 404, { error: 'Niet gevonden' });
          const c = (co.contacts || []).find((x) => x.id === body.contactId);
          if (!c) return json(res, 404, { error: 'Contactpersoon niet gevonden' });
          const patch = body.contact || {};
          if (patch.name !== undefined) c.name = String(patch.name).trim().slice(0, 200) || c.name;
          if (patch.email !== undefined) c.email = String(patch.email).trim().slice(0, 200);
          if (patch.phone !== undefined) c.phone = String(patch.phone).trim().slice(0, 60);
        } else if (body.action === 'contact-delete') {
          if (!co) return json(res, 404, { error: 'Niet gevonden' });
          co.contacts = (co.contacts || []).filter((x) => x.id !== body.contactId);
        } else if (body.action === 'delete') {
          if (!co) return json(res, 404, { error: 'Niet gevonden' });
          list = list.filter((x) => x.id !== body.id);
          // Also drop any acties tied to this company.
          const actKey = `crmact:${s.email}`;
          try {
            const acts = (await kvGetJson(actKey)) || [];
            await kvSetJson(actKey, acts.filter((a) => a.companyId !== body.id));
          } catch (e) { /* ignore */ }
        } else {
          return json(res, 400, { error: 'Onbekende actie' });
        }
        await kvSetJson(key, list);
        return json(res, 200, { ok: true, companies: list });
      }
    } catch (e) {
      console.error('crm companies API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/crm/ideas') {
    const s = getSession(req, 'crm');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    const key = `crmidea:${s.email}`;
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
      if (req.method === 'POST') {
        const body = await readBody(req);
        let list = (await kvGetJson(key)) || [];
        const todayISO = new Date().toISOString().slice(0, 10);
        const plus = (n) => {
          const d = new Date(todayISO + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + n);
          return d.toISOString().slice(0, 10);
        };
        if (body.action === 'create') {
          const title = String(body.title || '').trim().slice(0, 200);
          if (!title) return json(res, 400, { error: 'Titel is verplicht' });
          list.push({
            id: crypto.randomUUID(),
            title,
            desc: String(body.desc || '').trim().slice(0, 3000),
            createdAt: Date.now(),
            nextReview: plus(14),
            reviews: 0,
            archived: false,
          });
        } else {
          const r = list.find((x) => x.id === body.id);
          if (!r) return json(res, 404, { error: 'Niet gevonden' });
          if (body.action === 'update') {
            if (body.title !== undefined) r.title = String(body.title).trim().slice(0, 200) || r.title;
            if (body.desc !== undefined) r.desc = String(body.desc).trim().slice(0, 3000);
          } else if (body.action === 'keep') {
            r.reviews = (r.reviews || 0) + 1;
            r.nextReview = plus(r.reviews === 1 ? 42 : 90);
          } else if (body.action === 'archive') {
            r.archived = true;
          } else if (body.action === 'restore') {
            r.archived = false;
            r.reviews = 0;
            r.nextReview = plus(14);
          } else if (body.action === 'delete') {
            list = list.filter((x) => x.id !== body.id);
          } else {
            return json(res, 400, { error: 'Onbekende actie' });
          }
        }
        await kvSetJson(key, list);
        return json(res, 200, { ok: true, ideas: list });
      }
    } catch (e) {
      console.error('crm ideas API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/crm/actions') {
    const s = getSession(req, 'crm');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    const key = `crmact:${s.email}`;
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
      if (req.method === 'POST') {
        const body = await readBody(req);
        let list = (await kvGetJson(key)) || [];
        if (body.action === 'create') {
          const companyId = String(body.companyId || '').trim();
          if (!companyId) return json(res, 400, { error: 'Bedrijf is verplicht' });
          list.push({
            id: crypto.randomUUID(),
            companyId,
            note: String(body.note || '').trim().slice(0, 2000),
            due: String(body.due || '').slice(0, 10),
            time: /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : '',
            prio: Math.min(4, Math.max(1, Number(body.prio) || 4)),
            done: !!body.done,
            createdAt: Date.now(),
          });
        } else if (body.action === 'update') {
          const a = list.find((x) => x.id === body.id);
          if (!a) return json(res, 404, { error: 'Niet gevonden' });
          if (body.companyId !== undefined) a.companyId = String(body.companyId).trim() || a.companyId;
          if (body.note !== undefined) a.note = String(body.note).trim().slice(0, 2000);
          if (body.due !== undefined) a.due = String(body.due).slice(0, 10);
          if (body.time !== undefined) a.time = /^\d{2}:\d{2}$/.test(String(body.time)) ? String(body.time) : '';
          if (body.prio !== undefined) a.prio = Math.min(4, Math.max(1, Number(body.prio) || 4));
          if (body.done !== undefined) a.done = !!body.done;
        } else if (body.action === 'delete') {
          list = list.filter((x) => x.id !== body.id);
        } else {
          return json(res, 400, { error: 'Onbekende actie' });
        }
        await kvSetJson(key, list);
        return json(res, 200, { ok: true, actions: list });
      }
    } catch (e) {
      console.error('crm actions API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/reminders') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    const key = `rem:${s.email}`;
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
      if (req.method === 'POST') {
        const body = await readBody(req);
        let list = (await kvGetJson(key)) || [];
        if (body.action === 'create') {
          const title = String(body.title || '').trim().slice(0, 200);
          if (!title) return json(res, 400, { error: 'Titel is verplicht' });
          list.push({
            id: crypto.randomUUID(),
            title,
            note: String(body.note || '').trim().slice(0, 2000),
            due: String(body.due || '').slice(0, 10),
            time: /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : '',
            prio: Math.min(4, Math.max(1, Number(body.prio) || 4)),
            done: false,
            createdAt: Date.now(),
          });
          bump('rc');
        } else if (body.action === 'update') {
          const r = list.find((x) => x.id === body.id);
          if (!r) return json(res, 404, { error: 'Niet gevonden' });
          if (body.title !== undefined) r.title = String(body.title).trim().slice(0, 200) || r.title;
          if (body.note !== undefined) r.note = String(body.note).trim().slice(0, 2000);
          if (body.due !== undefined) r.due = String(body.due).slice(0, 10);
          if (body.time !== undefined) r.time = /^\d{2}:\d{2}$/.test(String(body.time)) ? String(body.time) : '';
          if (body.prio !== undefined) r.prio = Math.min(4, Math.max(1, Number(body.prio) || 4));
          if (body.done !== undefined) {
            if (body.done && !r.done) bump('rd');
            r.done = !!body.done;
          }
        } else if (body.action === 'delete') {
          list = list.filter((x) => x.id !== body.id);
        } else {
          return json(res, 400, { error: 'Onbekende actie' });
        }
        await kvSetJson(key, list);
        return json(res, 200, { ok: true, reminders: list });
      }
    } catch (e) {
      console.error('reminders API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/suggestions') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    const key = `sug:${s.email}`;
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
      if (req.method === 'POST') {
        const body = await readBody(req);
        let list = (await kvGetJson(key)) || [];
        const todayISO = new Date().toISOString().slice(0, 10);
        const addCycle = (r, fromISO) => {
          const d = new Date(fromISO + 'T00:00:00Z');
          if (r.ftype === 'months') {
            const day = r.fday || 1;
            d.setUTCDate(1);
            d.setUTCMonth(d.getUTCMonth() + (r.fn || 1));
            const max = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
            d.setUTCDate(Math.min(day, max));
          } else {
            d.setUTCDate(d.getUTCDate() + (r.fn || 1) * (r.ftype === 'weeks' ? 7 : 1));
          }
          return d.toISOString().slice(0, 10);
        };
        const sanitize = (r, body) => {
          if (body.text !== undefined) r.text = String(body.text).trim().slice(0, 300) || r.text;
          if (body.ftype !== undefined) r.ftype = ['days', 'weeks', 'months'].includes(body.ftype) ? body.ftype : 'months';
          if (body.fn !== undefined) r.fn = Math.min(365, Math.max(1, Number(body.fn) || 1));
          if (body.fday !== undefined) r.fday = Math.min(31, Math.max(1, Number(body.fday) || 1));
          if (body.first !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(body.first))) r.nextDue = body.first;
        };
        if (body.action === 'create') {
          const text = String(body.text || '').trim().slice(0, 300);
          if (!text) return json(res, 400, { error: 'Tekst is verplicht' });
          const r = { id: crypto.randomUUID(), text, ftype: 'months', fn: 1, fday: 1, nextDue: todayISO, createdAt: Date.now() };
          sanitize(r, body);
          list.push(r);
        } else {
          const r = list.find((x) => x.id === body.id);
          if (body.action === 'delete') {
            if (!r) return json(res, 404, { error: 'Niet gevonden' });
            list = list.filter((x) => x.id !== body.id);
          } else if (body.action === 'update') {
            if (!r) return json(res, 404, { error: 'Niet gevonden' });
            sanitize(r, body);
          } else if (body.action === 'done' || body.action === 'skip') {
            if (!r) return json(res, 404, { error: 'Niet gevonden' });
            r.nextDue = addCycle(r, r.nextDue > todayISO ? r.nextDue : todayISO);
          } else if (body.action === 'snooze') {
            if (!r) return json(res, 404, { error: 'Niet gevonden' });
            const d = new Date(todayISO + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + Math.min(30, Math.max(1, Number(body.days) || 3)));
            r.nextDue = d.toISOString().slice(0, 10);
          } else {
            return json(res, 400, { error: 'Onbekende actie' });
          }
        }
        await kvSetJson(key, list);
        return json(res, 200, { ok: true, suggestions: list });
      }
    } catch (e) {
      console.error('suggestions API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/ideas') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    const key = `idea:${s.email}`;
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
      if (req.method === 'POST') {
        const body = await readBody(req);
        let list = (await kvGetJson(key)) || [];
        const todayISO = new Date().toISOString().slice(0, 10);
        const plus = (n) => {
          const d = new Date(todayISO + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + n);
          return d.toISOString().slice(0, 10);
        };
        if (body.action === 'create') {
          const title = String(body.title || '').trim().slice(0, 200);
          if (!title) return json(res, 400, { error: 'Titel is verplicht' });
          list.push({
            id: crypto.randomUUID(),
            title,
            desc: String(body.desc || '').trim().slice(0, 3000),
            createdAt: Date.now(),
            nextReview: plus(14),
            reviews: 0,
            archived: false,
          });
          bump('id');
        } else {
          const r = list.find((x) => x.id === body.id);
          if (!r) return json(res, 404, { error: 'Niet gevonden' });
          if (body.action === 'update') {
            if (body.title !== undefined) r.title = String(body.title).trim().slice(0, 200) || r.title;
            if (body.desc !== undefined) r.desc = String(body.desc).trim().slice(0, 3000);
          } else if (body.action === 'keep') {
            r.reviews = (r.reviews || 0) + 1;
            r.nextReview = plus(r.reviews === 1 ? 42 : 90);
          } else if (body.action === 'archive') {
            r.archived = true;
          } else if (body.action === 'restore') {
            r.archived = false;
            r.reviews = 0;
            r.nextReview = plus(14);
          } else if (body.action === 'delete') {
            list = list.filter((x) => x.id !== body.id);
          } else {
            return json(res, 400, { error: 'Onbekende actie' });
          }
        }
        await kvSetJson(key, list);
        return json(res, 200, { ok: true, ideas: list });
      }
    } catch (e) {
      console.error('ideas API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/profile') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    const key = `pref:${s.email}`;
    const defaults = { name: '', lang: 'en', sugSnoozeDays: 3, showSugCards: true, showIdeaCards: true };
    try {
      if (req.method === 'GET') {
        const pr = (await kvGetJson(key)) || {};
        return json(res, 200, { ...defaults, ...pr });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const pr = { ...defaults, ...((await kvGetJson(key)) || {}) };
        if (body.name !== undefined) pr.name = String(body.name).trim().slice(0, 60);
        if (body.lang !== undefined) pr.lang = ['en', 'nl'].includes(body.lang) ? body.lang : 'en';
        if (body.sugSnoozeDays !== undefined) pr.sugSnoozeDays = Math.min(30, Math.max(1, Number(body.sugSnoozeDays) || 3));
        if (body.showSugCards !== undefined) pr.showSugCards = !!body.showSugCards;
        if (body.showIdeaCards !== undefined) pr.showIdeaCards = !!body.showIdeaCards;
        await kvSetJson(key, pr);
        return json(res, 200, pr);
      }
    } catch (e) {
      console.error('profile API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/log') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    if (s.email !== ADMIN_EMAIL) return json(res, 403, { error: 'Geen toegang' });
    try {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - i);
        const d = dt.toISOString().slice(0, 10);
        const get = async (k) => Number(await kvCmd('GET', `st:${d}:${k}`).catch(() => 0)) || 0;
        const uniq = Number(await kvCmd('PFCOUNT', `st:${d}:u`).catch(() => 0)) || 0;
        days.push({ date: d, v: await get('v'), u: uniq, l: await get('l'), rd: await get('rd') });
      }
      return json(res, 200, { days });
    } catch (e) {
      console.error('log API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  if (p === '/api/telegram') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    if (s.email !== ADMIN_EMAIL) return json(res, 403, { error: 'Geen toegang' });
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    try {
      if (req.method === 'GET') {
        const chat = KV_URL ? await kvCmd('GET', 'tg:chat').catch(() => null) : null;
        return json(res, 200, { configured: !!token, linked: !!chat });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!token) return json(res, 400, { error: 'Zet eerst TELEGRAM_BOT_TOKEN in Render.' });
        if (body.action === 'link') {
          const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
          const d = await r.json();
          if (!d.ok) return json(res, 400, { error: 'Bot-token lijkt ongeldig.' });
          const withMsg = (d.result || []).filter((u) => u.message && u.message.chat);
          if (!withMsg.length) return json(res, 400, { error: 'Geen bericht gevonden. Stuur eerst een berichtje naar je bot en probeer opnieuw.' });
          const chat = withMsg[withMsg.length - 1].message.chat.id;
          await kvCmd('SET', 'tg:chat', String(chat));
          await tgSend('Gekoppeld! Dit is het kanaal voor je VDK-meldingen en dagoverzichten.');
          return json(res, 200, { ok: true, linked: true });
        }
        if (body.action === 'test') {
          const ok = await tgSend('Testbericht van je VDK-paneel. Werkt!');
          return ok ? json(res, 200, { ok: true }) : json(res, 400, { error: 'Versturen mislukt. Is de bot gekoppeld?' });
        }
        return json(res, 400, { error: 'Onbekende actie' });
      }
    } catch (e) {
      console.error('telegram API error:', e.message);
      return json(res, 500, { error: 'Telegram niet bereikbaar.' });
    }
  }

  if (p === '/api/cron/daily') {
    const secret = (process.env.CRON_SECRET || '').trim();
    if (!secret || url.searchParams.get('key') !== secret) {
      return json(res, 403, { error: 'Forbidden' });
    }
    try {
      const range = url.searchParams.get('range');
      const text = range === 'week' ? await weeklySummaryText() : await dailySummaryText();
      const ok = await tgSend(text);
      logEvent('dagoverzicht', ok ? 'verstuurd via Telegram' : 'Telegram niet gekoppeld');
      return json(res, 200, { ok, summary: text });
    } catch (e) {
      console.error('cron error:', e.message);
      return json(res, 500, { error: 'Samenvatting mislukt.' });
    }
  }

  if (p === '/api/settings') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    if (s.email !== ADMIN_EMAIL) return json(res, 403, { error: 'Geen toegang' });
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson('settings')) || { lockedToAdmin: true, lockedCrmToAdmin: true });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const prev = (await kvGetJson('settings')) || {};
        const st = {
          lockedToAdmin: body.lockedToAdmin !== undefined ? body.lockedToAdmin !== false : (prev.lockedToAdmin !== false),
          lockedCrmToAdmin: body.lockedCrmToAdmin !== undefined ? body.lockedCrmToAdmin !== false : (prev.lockedCrmToAdmin !== false),
        };
        await kvSetJson('settings', st);
        return json(res, 200, st);
      }
    } catch (e) {
      console.error('settings API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  // --- Base pages ---
  if (p === '/base' || p === '/base/') {
    const s = getSession(req, 'admin');
    return serveFile(res, path.join(__dirname, s ? 'panel.html' : 'login.html'));
  }
  if (p === '/base/me') {
    const s = getSession(req, 'admin');
    if (!s) return json(res, 401, { error: 'Not logged in' });
    return json(res, 200, { email: s.email });
  }

  // --- CRM pages (separate service: own login, own session, own page) ---
  if (p === '/crm' || p === '/crm/') {
    const s = getSession(req, 'crm');
    return serveFile(res, path.join(__dirname, s ? 'crm.html' : 'crm-login.html'));
  }

  // --- Public pages (explicit whitelist only) ---
  if (p === '/') {
    bump('v');
    bumpUniq(ip);
    return serveFile(res, path.join(__dirname, 'index.html'));
  }
  if (p === '/logo.png') return serveFile(res, path.join(__dirname, 'logo.png'));
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Cleanup expired sessions/codes hourly
setInterval(() => {
  const now = Date.now();
  for (const realm of Object.keys(sessionStores)) {
    for (const [k, v] of sessionStores[realm]) if (now > v.expires) sessionStores[realm].delete(k);
  }
  for (const [k, v] of codes) if (now > v.expires) codes.delete(k);
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`VDK Business Services running on http://localhost:${PORT}`);
  if (!smtpConfigured()) console.log('Note: SMTP not configured — 2FA codes are printed to this console (dev mode).');
});
