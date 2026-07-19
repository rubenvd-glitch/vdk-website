// VDK Business Services — website + 2FA admin panel
// Zero dependencies: runs with plain Node.js (v18+). Start with: node server.js
'use strict';

const http = require('http');
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
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function sendMail({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = process.env.SMTP_USER;
    const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
    const from = process.env.MAIL_FROM || user;

    let socket;
    let buffer = '';
    let steps = [];
    let stepIndex = 0;
    let upgraded = false;

    const fail = (err) => { try { socket.destroy(); } catch (_) {} reject(err); };
    const write = (line) => socket.write(line + '\r\n');

    function buildSteps() {
      steps = [
        { expect: 220, send: () => write('EHLO vdkbusiness-services.nl') },
      ];
      if (!secure && !upgraded) {
        steps.push({ expect: 250, send: () => write('STARTTLS') });
        steps.push({ expect: 220, send: upgradeTls });
      } else {
        steps.push({ expect: 250, send: () => write('AUTH LOGIN') });
        steps.push({ expect: 334, send: () => write(Buffer.from(user).toString('base64')) });
        steps.push({ expect: 334, send: () => write(Buffer.from(pass).toString('base64')) });
        steps.push({ expect: 235, send: () => write(`MAIL FROM:<${from}>`) });
        steps.push({ expect: 250, send: () => write(`RCPT TO:<${to}>`) });
        steps.push({ expect: 250, send: () => write('DATA') });
        steps.push({ expect: 354, send: () => {
          const msg = [
            `From: VDK Business Services <${from}>`,
            `To: <${to}>`,
            `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <${crypto.randomUUID()}@vdkbusiness-services.nl>`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            text.replace(/\n/g, '\r\n'),
            '.',
          ].join('\r\n');
          socket.write(msg + '\r\n');
        }});
        steps.push({ expect: 250, send: () => { write('QUIT'); resolve(); } });
      }
    }

    function upgradeTls() {
      socket.removeAllListeners('data');
      const plain = socket;
      socket = tls.connect({ socket: plain, servername: host }, () => {
        upgraded = true;
        stepIndex = 0;
        buffer = '';
        buildSteps();
        // After TLS upgrade, we re-send EHLO ourselves (no 220 greeting)
        steps[0] = { expect: 250, send: () => {} }; // placeholder, EHLO response handled below
        write('EHLO vdkbusiness-services.nl');
        // Rebuild steps so the flow continues from AUTH after EHLO's 250
        steps = [
          { expect: 250, send: () => write('AUTH LOGIN') },
          { expect: 334, send: () => write(Buffer.from(user).toString('base64')) },
          { expect: 334, send: () => write(Buffer.from(pass).toString('base64')) },
          { expect: 235, send: () => write(`MAIL FROM:<${from}>`) },
          { expect: 250, send: () => write(`RCPT TO:<${to}>`) },
          { expect: 250, send: () => write('DATA') },
          { expect: 354, send: () => {
            const msg = [
              `From: VDK Business Services <${from}>`,
              `To: <${to}>`,
              `Subject: ${subject}`,
              `Date: ${new Date().toUTCString()}`,
              `Message-ID: <${crypto.randomUUID()}@vdkbusiness-services.nl>`,
              'MIME-Version: 1.0',
              'Content-Type: text/plain; charset=utf-8',
              '',
              text.replace(/\n/g, '\r\n'),
              '.',
            ].join('\r\n');
            socket.write(msg + '\r\n');
          }},
          { expect: 250, send: () => { write('QUIT'); resolve(); } },
        ];
        stepIndex = 0;
        socket.on('data', onData);
        socket.on('error', fail);
      });
      socket.on('error', fail);
    }

    function onData(chunk) {
      buffer += chunk.toString();
      // Process complete lines; multi-line replies end with "NNN " (space after code)
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!/^\d{3} /.test(line)) continue; // continuation line
        const code = Number(line.slice(0, 3));
        const step = steps[stepIndex];
        if (!step) return;
        if (code !== step.expect) return fail(new Error(`SMTP error: expected ${step.expect}, got "${line}"`));
        stepIndex++;
        step.send();
      }
    }

    buildSteps();
    if (secure) {
      socket = tls.connect({ host, port, servername: host }, () => {});
    } else {
      socket = net.connect({ host, port });
    }
    socket.setTimeout(15000, () => fail(new Error('SMTP timeout')));
    socket.on('data', onData);
    socket.on('error', fail);
  });
}

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
    if (email !== ADMIN_EMAIL) return json(res, 200, generic);

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
        console.error('SMTP send failed:', err.message);
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
    const cookie = createSession(email);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(cookie, SESSION_TTL) });
  }

  if (req.method === 'POST' && p === '/admin/logout') {
    const s = getSession(req);
    if (s) sessions.delete(s.id);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
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
