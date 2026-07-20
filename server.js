// VDK Business Services — website + 2FA admin panel
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
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
const CODE_TTL = 10 * 60 * 1000; // 10 minutes

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

// ---------- Sessions (HMAC-signed cookie, in-memory store) ----------
const sessions = new Map(); // id -> { email, expires }

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSession(email) {
  const id = crypto.randomBytes(24).toString('base64url');
  sessions.set(id, { email, expires: Date.now() + SESSION_TTL });
  return `${id}.${sign(id)}`;
}

function getSession(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  const raw = cookies['vdk_sid'];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(id);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const s = sessions.get(id);
  if (!s || Date.now() > s.expires) { sessions.delete(id); return null; }
  return { id, ...s };
}

function sessionCookie(value, maxAgeMs) {
  const parts = [
    `vdk_sid=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

// ---------- 2FA codes + rate limiting (in-memory) ----------
const codes = new Map(); // email -> { hash, expires, attempts }
const rateLimit = new Map(); // ip -> { count, resetAt }

const hashCode = (c) => crypto.createHash('sha256').update(c).digest('hex');

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

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  // --- Auth API ---
  if (req.method === 'POST' && p === '/admin/request-code') {
    if (!allowRate(ip)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const generic = { ok: true, message: 'If this email is authorized, a code has been sent.' };
    let allowed = email === ADMIN_EMAIL && email.includes('@');
    if (!allowed && email.includes('@') && KV_URL) {
      try {
        if (await kvGetJson(`user:${email}`)) allowed = true;
        else {
          const st = await kvGetJson('settings');
          if (st && st.lockedToAdmin === false) allowed = true;
        }
      } catch (e) { console.error('KV check failed:', e.message); }
    }
    if (!allowed) return json(res, 200, generic);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    codes.set(email, { hash: hashCode(code), expires: Date.now() + CODE_TTL, attempts: 0 });

    if (smtpConfigured()) {
      try {
        await sendMail({
          to: email,
          subject: `Your VDK admin login code: ${code}`,
          text: `Your login code for the VDK Business Services admin panel is: ${code}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`,
        });
      } catch (err) {
        console.error('SMTP send failed:', (err && (err.stack || err.message)) || String(err));
        return json(res, 500, { error: 'Could not send email. Check SMTP settings.' });
      }
    } else {
      console.log(`[DEV] No SMTP configured. Login code for ${email}: ${code}`);
    }
    return json(res, 200, generic);
  }

  if (req.method === 'POST' && p === '/admin/verify') {
    if (!allowRate(ip)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const entry = codes.get(email);
    if (email !== ADMIN_EMAIL || !entry || Date.now() > entry.expires) {
      return json(res, 401, { error: 'Invalid or expired code.' });
    }
    if (++entry.attempts > 5) {
      codes.delete(email);
      return json(res, 401, { error: 'Too many wrong codes. Request a new one.' });
    }
    const ok = crypto.timingSafeEqual(Buffer.from(hashCode(code)), Buffer.from(entry.hash));
    if (!ok) return json(res, 401, { error: 'Invalid or expired code.' });
    codes.delete(email);
    // First login of a non-admin: create the account (only while registration is open)
    if (email !== ADMIN_EMAIL && KV_URL) {
      try {
        if (!(await kvGetJson(`user:${email}`))) {
          const st = await kvGetJson('settings');
          if (!st || st.lockedToAdmin !== false) return json(res, 401, { error: 'Invalid or expired code.' });
          await kvSetJson(`user:${email}`, { createdAt: Date.now() });
        }
      } catch (e) {
        console.error('KV user create failed:', e.message);
        return json(res, 500, { error: 'Storage unavailable.' });
      }
    }
    const cookie = createSession(email);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(cookie, SESSION_TTL) });
  }

  if (req.method === 'POST' && p === '/admin/logout') {
    const s = getSession(req);
    if (s) sessions.delete(s.id);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // --- Panel API ---
  if (p === '/api/me') {
    const s = getSession(req);
    if (!s) return json(res, 401, { error: 'Not logged in' });
    return json(res, 200, { email: s.email, isAdmin: s.email === ADMIN_EMAIL });
  }

  if (p === '/api/reminders') {
    const s = getSession(req);
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
        } else if (body.action === 'update') {
          const r = list.find((x) => x.id === body.id);
          if (!r) return json(res, 404, { error: 'Niet gevonden' });
          if (body.title !== undefined) r.title = String(body.title).trim().slice(0, 200) || r.title;
          if (body.note !== undefined) r.note = String(body.note).trim().slice(0, 2000);
          if (body.due !== undefined) r.due = String(body.due).slice(0, 10);
          if (body.time !== undefined) r.time = /^\d{2}:\d{2}$/.test(String(body.time)) ? String(body.time) : '';
          if (body.prio !== undefined) r.prio = Math.min(4, Math.max(1, Number(body.prio) || 4));
          if (body.done !== undefined) r.done = !!body.done;
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
    const s = getSession(req);
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

  if (p === '/api/settings') {
    const s = getSession(req);
    if (!s) return json(res, 401, { error: 'Not logged in' });
    if (s.email !== ADMIN_EMAIL) return json(res, 403, { error: 'Geen toegang' });
    try {
      if (req.method === 'GET') return json(res, 200, (await kvGetJson('settings')) || { lockedToAdmin: true });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const st = { lockedToAdmin: body.lockedToAdmin !== false };
        await kvSetJson('settings', st);
        return json(res, 200, st);
      }
    } catch (e) {
      console.error('settings API error:', e.message);
      return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
    }
  }

  // --- Admin pages ---
  if (p === '/admin' || p === '/admin/') {
    const s = getSession(req);
    return serveFile(res, path.join(__dirname, s ? 'panel.html' : 'login.html'));
  }
  if (p === '/admin/me') {
    const s = getSession(req);
    if (!s) return json(res, 401, { error: 'Not logged in' });
    return json(res, 200, { email: s.email });
  }

  // --- Public pages (explicit whitelist only) ---
  if (p === '/') return serveFile(res, path.join(__dirname, 'index.html'));
  if (p === '/logo.png') return serveFile(res, path.join(__dirname, 'logo.png'));
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Cleanup expired sessions/codes hourly
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (now > v.expires) sessions.delete(k);
  for (const [k, v] of codes) if (now > v.expires) codes.delete(k);
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`VDK Business Services running on http://localhost:${PORT}`);
  if (!smtpConfigured()) console.log('Note: SMTP not configured — 2FA codes are printed to this console (dev mode).');
});
