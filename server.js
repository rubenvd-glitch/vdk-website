// VDK Business Services — website + 2FA admin panel (Base) + separate CRM service + Gym Assistant
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
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days — stay logged in on trusted devices
const CODE_TTL = 10 * 60 * 1000; // 10 minutes

// CRM: fixed sector list for company categorization.
const CRM_SECTORS = [
'Horeca', 'Sport & Fitness', 'Financien & Verzekeringen', 'Vastgoed & Makelaardij',
'Bouw & Techniek', 'Detailhandel & Retail', 'Zorg & Welzijn', 'Onderwijs',
'Automotive & Transport', 'Media & Marketing', 'ICT & Technologie',
'Zakelijke Dienstverlening', 'Overheid & Non-profit', 'Evenementen & Cultuur',
'Voeding & Drank', 'Reizen & Vrije Tijd', 'Overig',
];

// CRM: sales-temperature scale for company status, matching the BCR spreadsheet.
const CRM_SALES_STATUSES = ['frozen', 'cold', 'lukewarm', 'warm', 'hot'];

// Base: fixed icon set for reminders, shown on the Timeline view (and the
// regular reminders list) — matches the icon ids the frontend's icon
// picker offers, so an unrecognized/missing value just falls back to no
// icon rather than breaking anything.
const REMINDER_ICONS = ['alarm', 'bed', 'dumbbell', 'coffee', 'briefcase', 'book', 'heart', 'car', 'home', 'bell', 'phone', 'mail', 'calendar', 'cart', 'gift', 'music', 'plane', 'utensils', 'pill', 'wrench'];
const isHexColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ''));

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
const kvDel = (k) => kvCmd('DEL', k);

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

// Sessions live in KV (so a Render restart/redeploy never logs you out) with
// the in-memory Map as a fast local cache / dev fallback when KV isn't set up.
async function createSession(realm, email) {
const id = crypto.randomBytes(24).toString('base64url');
const entry = { email, expires: Date.now() + SESSION_TTL };
sessionStores[realm].set(id, entry);
if (KV_URL) {
try { await kvCmd('SET', `sess:${realm}:${id}`, JSON.stringify(entry), 'EX', String(Math.ceil(SESSION_TTL / 1000))); }
catch (e) { console.error('session save failed:', e.message); }
}
return `${id}.${sign(id)}`;
}

async function destroySession(realm, id) {
sessionStores[realm].delete(id);
if (KV_URL) { try { await kvCmd('DEL', `sess:${realm}:${id}`); } catch (e) { /* ignore */ } }
}

async function getSession(req, realm) {
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
let s = store.get(id);
if (!s && KV_URL) {
try {
const v = await kvCmd('GET', `sess:${realm}:${id}`);
if (v) { s = JSON.parse(v); store.set(id, s); }
} catch (e) { console.error('session load failed:', e.message); }
}
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

// ---------- Calendar integration: Apple Calendar (CalDAV) ----------
// Works for both realms (admin/Base and crm/CRM) independently. Credentials are
// namespaced per realm+email in KV, never shared between the two apps.
// Google Calendar was scaffolded earlier (OAuth2) but removed 2026-07-25 at the
// user's request — no users yet, so no point maintaining untested surface area.
// Push it back when someone actually asks for Google; see CONTEXT.md for what
// existed (constants, handlers, routes, UI) so it can be restored quickly.
function calAppleKey(realm, email) { return `cala:${realm}:${email}`; }

// ---------- Apple Calendar via CalDAV (basic auth with an app-specific password) ----------
function caldavRequest(urlStr, { method = 'GET', headers = {}, body, auth } = {}) {
return new Promise((resolve, reject) => {
const u = new URL(urlStr);
const basic = Buffer.from(`${auth.appleId}:${auth.appPassword}`).toString('base64');
// Set an explicit Content-Length instead of letting Node fall back to
// chunked transfer-encoding — some CalDAV server configurations (iCloud
// included, per observed behaviour) reject chunked PROPFIND/REPORT
// bodies with an empty-body 400 rather than a helpful error.
const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
const req = https.request(
{
hostname: u.hostname, path: u.pathname + u.search, method, port: 443,
headers: {
Authorization: `Basic ${basic}`,
'Content-Type': headers['Content-Type'] || 'text/xml; charset=utf-8',
Depth: headers.Depth || '0',
// Node sets no User-Agent by default. iCloud's edge appears to reject
// PROPFIND requests with an empty-body 400 for at least the calendar
// listing step, which is consistent with a WAF/UA filter — real CalDAV
// clients (macOS CalendarAgent, DAVKit-based apps) always send one.
'User-Agent': headers['User-Agent'] || 'DAVKit/8.0.3 (1197); CalendarStore/8.0.3 (1197); iCal/8.0.3 (1197); Mac OS X/10.15.7 (19H2)',
...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
...headers,
},
timeout: 15000,
},
(res) => {
let data = '';
res.on('data', (c) => (data += c));
res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, url: u }));
}
);
req.on('timeout', () => { req.destroy(); reject(new Error('CalDAV timeout')); });
req.on('error', reject);
if (bodyBuf) req.write(bodyBuf);
req.end();
});
}

function xmlTag(body, tag) {
const m = body.match(new RegExp(`<[^:>]*:?${tag}[^>]*>([^<]*)</[^:>]*:?${tag}>`, 'i'));
return m ? m[1].trim() : '';
}
function xmlHrefs(body) {
const out = [];
const re = /<[^:>]*:?href[^>]*>([^<]*)<\/[^:>]*:?href>/gi;
let m;
while ((m = re.exec(body))) out.push(m[1].trim());
return out;
}
// Extracts the href nested specifically INSIDE a given property tag (e.g.
// <current-user-principal><href>...</href></current-user-principal>).
// Critical distinction from xmlHrefs(body)[0]: a WebDAV multistatus
// response's very first <href> is almost always the outer
// <response><href> that just echoes back the requested resource's own
// URL, NOT the property value being asked for. Blindly taking the first
// href in the whole document silently "discovers" the request URL itself
// as if it were the principal/calendar-home-set, which is why this
// bounced back to https://caldav.icloud.com/ instead of a real account
// path — the bug was here, not in redirects/XML namespaces/encoding.
function xmlPropHref(body, tag) {
const propRe = new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'i');
const m = body.match(propRe);
if (!m) return '';
return xmlHrefs(m[1])[0] || '';
}

// Sends a CalDAV request and transparently follows redirects (iCloud routes
// each account to a partitioned host like pXX-caldav.icloud.com and issues a
// 301/302 for almost every step of discovery, not just the very first call).
async function caldavRequestFollow(urlStr, opts, maxRedirects = 5) {
let currentUrl = urlStr;
let r = await caldavRequest(currentUrl, opts);
let hops = 0;
while (r.status >= 300 && r.status < 400 && r.headers.location && hops < maxRedirects) {
currentUrl = new URL(r.headers.location, r.url).toString();
r = await caldavRequest(currentUrl, opts);
hops += 1;
}
return r;
}

// Discovers the user's default calendar via CalDAV well-known discovery.
// iCloud splits accounts across partitioned servers, so every step (not just
// the first) can come back as a redirect to that partition's host.
function caldavDiag(r) {
// Diagnostic snippet appended to error messages so failures are
// debuggable from the thrown message alone (surfaced in the UI/logs)
// instead of requiring a fresh guess-and-redeploy cycle each time.
// Dumps ALL response headers (not just a couple of guessed names) since
// an empty response body on a 400 means the real signal, if any, is in
// the headers (server/WAF identity, rate-limit hints, etc).
const snippet = String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
let headersDump = '';
try { headersDump = JSON.stringify(r.headers || {}); } catch (e) { headersDump = '(unserializable)'; }
if (headersDump.length > 300) headersDump = headersDump.slice(0, 300) + '…';
return ` [status ${r.status}${snippet ? `, body: ${snippet}` : ', empty body'}, headers: ${headersDump}]`;
}

async function appleDiscoverCalendar(auth) {
const principalBody = `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/></A:prop></A:propfind>`;
const r = await caldavRequestFollow('https://caldav.icloud.com/', {
method: 'PROPFIND', headers: { Depth: '0' }, body: principalBody, auth,
});
if (r.status === 401) throw new Error('Ongeldige iCloud-inloggegevens of app-specifiek wachtwoord.');
// Must read the href nested inside <current-user-principal>, not just
// "the first href in the response" (that's the resource's own self-href).
const principalHref = xmlPropHref(r.body, 'current-user-principal');
if (!principalHref) throw new Error(`Kon geen iCloud-principal vinden. Klopt het app-specifiek wachtwoord?${caldavDiag(r)}`);
const principalUrl = new URL(principalHref, r.url).toString();

const homeBody = `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><C:calendar-home-set/></A:prop></A:propfind>`;
const rh = await caldavRequestFollow(principalUrl, { method: 'PROPFIND', headers: { Depth: '0' }, body: homeBody, auth });
if (rh.status === 401) throw new Error('Ongeldige iCloud-inloggegevens of app-specifiek wachtwoord.');
// Same fix here: read the href nested inside <calendar-home-set>, not the
// outer <response><href> (which would just echo back principalUrl).
const homeHref = xmlPropHref(rh.body, 'calendar-home-set');
const allHomeHrefs = xmlHrefs(rh.body);
if (!homeHref) throw new Error(`Kon geen agenda-basis vinden bij iCloud. [candidates seen: ${JSON.stringify(allHomeHrefs)}]${caldavDiag(rh)}`);
let homeUrl = new URL(homeHref, rh.url).toString();
// WebDAV collections must be addressed with a trailing slash — some
// servers (Apple's included, per observed behaviour) 400 a Depth:1
// PROPFIND against a collection URL missing one.
if (!homeUrl.endsWith('/')) homeUrl += '/';

const listBody = `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
<A:prop><A:resourcetype/><A:displayname/><C:supported-calendar-component-set/></A:prop>
</A:propfind>`;
const rl = await caldavRequestFollow(homeUrl, { method: 'PROPFIND', headers: { Depth: '1' }, body: listBody, auth });
// Exclude iCloud's internal CalDAV scheduling collections (inbox/outbox/
// notification) — these show up alongside real calendars under the
// home-set but aren't calendars at all; querying them for events just
// returns 403/404 on every dashboard load for no benefit.
const hrefs = xmlHrefs(rl.body).filter((h) => h !== new URL(homeUrl).pathname && h.endsWith('/')
&& !/\/(inbox|outbox|notification|notifications)\/$/i.test(h));
if (!hrefs.length) {
// Surface the exact URL we queried and every candidate href seen in the
// previous step, so a wrong homeHref pick (e.g. picking the request's
// own echoed href instead of the real calendar-home-set value) is
// immediately visible instead of requiring another guess.
throw new Error(`Geen agenda's gevonden in je iCloud-account. [home-url: ${homeUrl}, home-candidates: ${JSON.stringify(allHomeHrefs)}]${caldavDiag(rl)}`);
}
// Prefer a calendar literally called "home"/"Home"/"Agenda" if present for
// the default WRITE calendar (used when pushing a reminder), but return
// every discovered calendar too — an account can have several (Home,
// Work, Birthdays, shared calendars, ...), and the actual events a user
// expects to see may live on one that this name heuristic doesn't match.
// Reading only the single "chosen" one would silently show "nothing
// scheduled" even when today genuinely has events, just on another
// calendar.
let chosen = hrefs.find((h) => /home|agenda|kalender/i.test(h)) || hrefs[0];
const calendarUrl = new URL(chosen, homeUrl).toString();
const calendarUrls = hrefs.map((h) => new URL(h, homeUrl).toString());
return { principalUrl, calendarHomeUrl: homeUrl, calendarUrl, calendarUrls };
}

async function appleTestConnection(auth) {
const disc = await appleDiscoverCalendar(auth);
return disc;
}

function icalEscape(s) {
return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function icalDate(due, time) {
if (time) return due.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
return due.replace(/-/g, '');
}

// Parses a raw DTSTART/DTEND line body (everything after "DTSTART"/"DTEND",
// i.e. the optional ";PARAM=..." params plus the ":value") into a normal
// "YYYY-MM-DDTHH:MM:SS" string (or a bare "YYYY-MM-DD" for all-day events),
// so the front-end's existing `(ev.start || '').slice(11, 16)` time display
// actually works. Previously the raw iCal value (e.g. "20260726T140000" or
// "TZID=Europe/Amsterdam:20260726T140000") was passed straight through —
// slicing that at [11,16] doesn't line up with hours/minutes at all, which
// is why event times never showed up in the "Today's calendar" card.
function parseIcalDt(rawLine) {
// rawLine looks like ";TZID=Europe/Amsterdam:20260726T140000" or
// ";VALUE=DATE:20260726" or ":20260726T140000Z" (floating/UTC, no params).
const m = rawLine.match(/^([^:]*):(.+)$/);
if (!m) return { allDay: false, iso: '' };
const params = m[1] || '';
const value = m[2].trim();
const y = value.slice(0, 4), mo = value.slice(4, 6), d = value.slice(6, 8);
if (/VALUE=DATE\b/.test(params) || value.length === 8) {
return { allDay: true, iso: `${y}-${mo}-${d}` };
}
const hh = value.slice(9, 11), mi = value.slice(11, 13), ss = value.slice(13, 15) || '00';
if (value.endsWith('Z')) {
// UTC timestamp — convert to Europe/Amsterdam wall-clock time for display,
// since that's the timezone the business (and its users) operate in.
const utcMs = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
const parts = new Intl.DateTimeFormat('en-CA', {
timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).formatToParts(new Date(utcMs)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
return { allDay: false, iso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` };
}
// Floating time or an explicit TZID — the digits already represent the
// local wall-clock time in that zone, so use them as-is (no conversion
// needed to show "what time does this say on the calendar").
return { allDay: false, iso: `${y}-${mo}-${d}T${hh}:${mi}:${ss}` };
}

// --- Timezone-safe date helpers (Europe/Amsterdam) ---------------------
// The server process itself runs in UTC (confirmed via `date` /
// Intl.DateTimeFormat().resolvedOptions().timeZone on the hosting
// platform), but the business and its calendar operate in Europe/Amsterdam
// local time. These helpers compute the exact UTC instant corresponding to
// midnight in Amsterdam on a given calendar date, so "today"/"tomorrow"/
// "week"/"month" query windows line up with Amsterdam wall-clock days
// instead of UTC days (which would shift the boundary by 1-2 hours and
// could pull an event from the next day into "today", or vice versa).

function zonedOffsetMinutes(utcDate, timeZone) {
const dtf = new Intl.DateTimeFormat('en-US', {
timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const parts = dtf.formatToParts(utcDate).reduce((o, p) => { if (p.type !== 'literal') o[p.type] = p.value; return o; }, {});
const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
return Math.round((asUTC - utcDate.getTime()) / 60000);
}

function zonedTodayYMD(timeZone) {
const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
.formatToParts(new Date()).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
return { y: +parts.year, m: +parts.month, d: +parts.day };
}

function zonedMidnightUTC(ymd, timeZone) {
const guess = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0));
const offsetMin = zonedOffsetMinutes(guess, timeZone);
return new Date(guess.getTime() - offsetMin * 60000);
}

function addDaysToYMD(ymd, days) {
const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
dt.setUTCDate(dt.getUTCDate() + days);
return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function icalUTCStamp(date) {
return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

async function appleCreateEvent(cred, { title, note, due, time, duration }) {
const uid = `${crypto.randomUUID()}@vdkbusiness-services.nl`;
const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
let dtStart, dtEnd, allDayLines = '';
if (time) {
dtStart = `DTSTART;TZID=Europe/Amsterdam:${icalDate(due, time)}`;
const durationMin = Math.min(480, Math.max(1, Number(duration) || 60)); // default 1h, matches the timeline's own default
const end = new Date(`${due}T${time}:00`); end.setMinutes(end.getMinutes() + durationMin);
const endTime = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
dtEnd = `DTEND;TZID=Europe/Amsterdam:${icalDate(due, endTime)}`;
} else {
const endDate = new Date(due + 'T00:00:00'); endDate.setDate(endDate.getDate() + 1);
dtStart = `DTSTART;VALUE=DATE:${icalDate(due)}`;
dtEnd = `DTEND;VALUE=DATE:${endDate.toISOString().slice(0, 10).replace(/-/g, '')}`;
}
const ics = [
'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VDK Business Services//NL', 'BEGIN:VEVENT',
`UID:${uid}`, `DTSTAMP:${dtstamp}`, dtStart, dtEnd,
`SUMMARY:${icalEscape(title)}`,
note ? `DESCRIPTION:${icalEscape(note)}` : '',
'END:VEVENT', 'END:VCALENDAR',
].filter(Boolean).join('\r\n');
const eventUrl = new URL(`${uid}.ics`, cred.calendarUrl).toString();
const r = await caldavRequest(eventUrl, {
method: 'PUT', headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
body: ics, auth: { appleId: cred.appleId, appPassword: cred.appPassword },
});
if (r.status >= 400) throw new Error(`Apple Agenda gaf een fout (status ${r.status}).`);
return { ok: true, uid };
}

// startStamp/endStamp are full "YYYYMMDDTHHMMSSZ" UTC instants (built by
// `zonedMidnightUTC` below) — NOT bare calendar dates. Passing exact UTC
// instants (rather than assuming a date's UTC midnight lines up with the
// business's actual local midnight) is what makes "today"/"tomorrow"/etc.
// line up with Europe/Amsterdam wall-clock days instead of UTC days.
async function appleListEventsForCalendar(calendarUrl, auth, startStamp, endStamp) {
const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
<D:prop><D:getetag/><C:calendar-data/></D:prop>
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
<C:time-range start="${startStamp}" end="${endStamp}"/>
</C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
const r = await caldavRequestFollow(calendarUrl, {
method: 'REPORT', headers: { Depth: '1' }, body: reportBody, auth,
});
// Debug metadata travels alongside the events so the front-end can show
// real diagnostics (status code, raw block count, body snippet) instead
// of a bare "nothing scheduled" when something actually went wrong —
// errors here were previously swallowed silently, making it impossible
// to tell "genuinely zero events" apart from "the request failed".
const debug = { url: calendarUrl, status: r.status };
if (r.status >= 300) {
debug.note = 'non-2xx status';
debug.bodySnippet = String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 150);
return { events: [], debug };
}
const blocks = r.body.split(/BEGIN:VEVENT/).slice(1);
debug.blockCount = blocks.length;
const events = blocks.map((b) => {
const summary = (b.match(/SUMMARY:(.*)/) || [, ''])[1].trim();
const dtstartRaw = (b.match(/DTSTART([^\r\n]*)/) || [, ''])[1].trim();
const dtendRaw = (b.match(/DTEND([^\r\n]*)/) || [, ''])[1].trim();
const startInfo = parseIcalDt(dtstartRaw);
const endInfo = dtendRaw ? parseIcalDt(dtendRaw) : { iso: '' };
return { source: 'apple', title: summary || '(geen titel)', start: startInfo.iso, end: endInfo.iso, allDay: startInfo.allDay };
});
return { events, debug };
}

async function appleListEvents(cred, startDate, endDate) {
const auth = { appleId: cred.appleId, appPassword: cred.appPassword };
// Query every discovered calendar, not just the single "default" one
// picked at connect-time — an account can have several calendars (Home,
// Work, Birthdays, shared ones), and today's real events may live on one
// the name-heuristic didn't pick. Older stored connections (from before
// this fix) only have a single `calendarUrl`, so fall back to that.
const rawCalendarUrls = (cred.calendarUrls && cred.calendarUrls.length) ? cred.calendarUrls : [cred.calendarUrl];
// Filter out iCloud's internal scheduling collections here too (not just
// at connect-time) so accounts that connected before that filter existed
// stop querying them without needing to reconnect.
const calendarUrls = rawCalendarUrls.filter((u) => !/\/(inbox|outbox|notification|notifications)\/$/i.test(u));
const perCalendar = await Promise.all(
calendarUrls.map((url) => appleListEventsForCalendar(url, auth, startDate, endDate)
.catch((e) => ({ events: [], debug: { url, error: e.message } })))
);
return {
events: perCalendar.flatMap((r) => r.events),
debug: { calendarUrls, usingFallbackSingle: !(cred.calendarUrls && cred.calendarUrls.length), perCalendar: perCalendar.map((r) => r.debug) },
};
}

// Realm-aware handlers, mirroring the handleRequestCode/handleVerify pattern
// used for 2FA: one implementation, mounted for both "admin" (Base) and "crm".
async function handleCalendarStatus(req, res, realm) {
const s = await getSession(req, realm);
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const a = await kvGetJson(calAppleKey(realm, s.email));
return json(res, 200, {
apple: !!a, appleId: a && a.appleId ? a.appleId : null,
});
} catch (e) { return json(res, 200, { apple: false }); }
}

async function handleAppleConnect(req, res, realm) {
const s = await getSession(req, realm);
if (!s) return json(res, 401, { error: 'Not logged in' });
const body = await readBody(req);
const appleId = String(body.appleId || '').trim();
const appPassword = String(body.appPassword || '').trim().replace(/\s+/g, '');
if (!appleId || !appPassword) return json(res, 400, { error: 'Vul je iCloud e-mailadres en app-specifiek wachtwoord in.' });
try {
const disc = await appleTestConnection({ appleId, appPassword });
await kvSetJson(calAppleKey(realm, s.email), {
appleId, appPassword, calendarUrl: disc.calendarUrl, calendarUrls: disc.calendarUrls || [disc.calendarUrl], connectedAt: Date.now(),
});
logEvent('agenda gekoppeld', `apple (${realm})`);
return json(res, 200, { ok: true });
} catch (e) {
return json(res, 400, { error: e.message || 'Koppelen mislukt. Controleer je gegevens.' });
}
}

async function handleAppleDisconnect(req, res, realm) {
const s = await getSession(req, realm);
if (!s) return json(res, 401, { error: 'Not logged in' });
await kvDel(calAppleKey(realm, s.email)).catch(() => {});
return json(res, 200, { ok: true });
}

async function handleCalendarEvents(req, res, realm, url) {
const s = await getSession(req, realm);
if (!s) return json(res, 401, { error: 'Not logged in' });
const range = url.searchParams.get('range') || 'today';
const TZ = 'Europe/Amsterdam';
// `date` (YYYY-MM-DD) optionally overrides "today" as the base day — used
// by the timeline view to fetch a single arbitrary day (past or future)
// instead of being anchored to whatever day it is right now.
const dateParam = url.searchParams.get('date');
const dateMatch = dateParam && /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateParam);
const today = dateMatch
? { y: +dateMatch[1], m: +dateMatch[2], d: +dateMatch[3] }
: zonedTodayYMD(TZ);
const startOffsetDays = range === 'tomorrow' ? 1 : 0;
const spanDays = range === 'day' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : 1; // 'today'/'tomorrow'/'day' all span 1 day
const startYMD = addDaysToYMD(today, startOffsetDays);
const endYMD = addDaysToYMD(today, startOffsetDays + spanDays);
// Build the exact UTC instants for Amsterdam-local midnight of these two
// calendar dates — NOT the server process's own midnight (Render runs in
// UTC, and Amsterdam is 1-2 hours ahead, so naively using UTC midnight
// shifted the query window by that much and could pull in the first
// couple hours of the next day, e.g. showing a booking that only starts
// tomorrow under "today").
const startStamp = icalUTCStamp(zonedMidnightUTC(startYMD, TZ));
const endStamp = icalUTCStamp(zonedMidnightUTC(endYMD, TZ));
const events = [];
let debug = null;
try {
const a = await kvGetJson(calAppleKey(realm, s.email));
if (a) {
const result = await appleListEvents(a, startStamp, endStamp);
events.push(...result.events);
debug = result.debug;
}
} catch (e) { console.error('apple events error:', e.message); debug = { error: e.message }; }
events.sort((x, y) => String(x.start).localeCompare(String(y.start)));
return json(res, 200, { events, debug });
}

// Pushes an existing reminder (Base) or action (CRM) to the connected
// calendar(s) as a new event. Only ever called after the front-end shows a
// confirmation dialog to the user — never automatically.
async function handleCalendarPush(req, res, realm) {
const s = await getSession(req, realm);
if (!s) return json(res, 401, { error: 'Not logged in' });
const body = await readBody(req);
const title = String(body.title || '').trim().slice(0, 200);
const note = String(body.note || '').trim().slice(0, 2000);
const due = String(body.due || '').slice(0, 10);
const time = /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : '';
const duration = Math.min(480, Math.max(0, Number(body.duration) || 0));
const calendars = Array.isArray(body.calendars) ? body.calendars : [];
if (!title) return json(res, 400, { error: 'Titel ontbreekt.' });
if (!due) return json(res, 400, { error: 'Zonder datum kan er niets naar de agenda gepusht worden.' });
if (!calendars.length) return json(res, 400, { error: 'Kies minstens één agenda.' });
const results = {};
if (calendars.includes('apple')) {
try {
const cred = await kvGetJson(calAppleKey(realm, s.email));
if (!cred) throw new Error('Apple Agenda niet gekoppeld');
await appleCreateEvent(cred, { title, note, due, time, duration });
results.apple = 'ok';
} catch (e) { results.apple = e.message; }
}
return json(res, 200, { ok: true, results });
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
const cookie = await createSession(realm, email);
const setCookies = [sessionCookie(realm, cookie, SESSION_TTL)];
// Base and CRM are the same person's tools now — logging into either one as
// the admin also opens the other, so switching never asks for a second 2FA.
if (email === ADMIN_EMAIL) {
const otherRealm = realm === 'admin' ? 'crm' : 'admin';
const otherCookie = await createSession(otherRealm, email);
setCookies.push(sessionCookie(otherRealm, otherCookie, SESSION_TTL));
}
return json(res, 200, { ok: true }, { 'Set-Cookie': setCookies });
}

// ---------- Gym Coach: exercises, logged sets, body composition, goals ----------
// Lives inside Base — same "admin" session as reminders/suggestions, just its
// own KV namespace (gymex:/gymlog:/gymbc:/gymgoal:/gympref:<email>). Mirrors
// the CRM's create/update/delete-by-action pattern used across the app.
const GYM_DEFAULT_EXERCISES = [
'Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row',
'Pull-up', 'Dumbbell Curl', 'Leg Press', 'Lat Pulldown', 'Plank',
'Incline Dumbbell Press', 'Romanian Deadlift', 'Leg Curl', 'Dips', 'Hip Thrust',
];

function gymExKey(email) { return `gymex:${email}`; }
function gymLogKey(email) { return `gymlog:${email}`; }
function gymBcKey(email) { return `gymbc:${email}`; }
function gymGoalKey(email) { return `gymgoal:${email}`; }

function assistantHistKey(email) { return 'asst:' + email; }

async function buildAssistantContext(email) {
  const [reminders, sugs, ideas, gymGoals, gymLog, gymPrefs] = await Promise.all([
    kvGetJson('rem:' + email).catch(() => null),
    kvGetJson('sug:' + email).catch(() => null),
    kvGetJson('idea:' + email).catch(() => null),
    kvGetJson(gymGoalKey(email)).catch(() => null),
    kvGetJson(gymLogKey(email)).catch(() => null),
    kvGetJson('gympref:' + email).catch(() => null),
  ]);
  const now = Date.now();
  const todayISO = new Date(now).toISOString().slice(0, 10);
  const weekAheadISO = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
  const twoWeeksAgoISO = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
  const upcomingReminders = (reminders || [])
    .filter((r) => !r.done)
    .filter((r) => !r.due || r.due <= weekAheadISO)
    .slice(0, 30)
    .map((r) => ({ id: r.id, title: r.title, due: r.due || null, time: r.time || null, prio: r.prio }));
  const dueSuggestions = (sugs || [])
    .filter((x) => x.nextDue && x.nextDue <= weekAheadISO)
    .slice(0, 15)
    .map((x) => ({ id: x.id, text: x.text, nextDue: x.nextDue }));
  const openIdeas = (ideas || [])
    .filter((x) => !x.archived)
    .slice(0, 20)
    .map((x) => ({ id: x.id, title: x.title, nextReview: x.nextReview }));
  const openGoals = (gymGoals || [])
    .filter((g) => !g.done)
    .map((g) => (g.kind === 'exercise'
      ? { type: "exercise", exercise: g.exercise, repMin: g.repMin, repMax: g.repMax, targetWeight: g.targetWeight }
      : { type: "general", title: g.title, category: g.category, targetValue: g.targetValue, targetUnit: g.targetUnit }));
  const recentSets = (gymLog || [])
    .filter((x) => x.date >= twoWeeksAgoISO)
    .slice(-150)
    .map((x) => ({ exercise: x.exercise, date: x.date, weight: x.weight, reps: x.reps, muscle: x.muscle, restSeconds: x.restSeconds || null }));
  return {
    today: todayISO,
    upcomingReminders: upcomingReminders,
    dueSuggestions: dueSuggestions,
    openIdeas: openIdeas,
    gymGoals: openGoals,
    gymRecentSets: recentSets,
    gymPrefs: gymPrefs || {},
  };
}

const ASSISTANT_ACTION_TYPES = ['reminder_create', 'reminder_done', 'gym_log', 'idea_action', 'suggestion_action'];

function validateAssistantAction(action, ctx) {
  if (!action || typeof action !== 'object') return null;
  const type = action.type;
  if (!ASSISTANT_ACTION_TYPES.includes(type)) return null;
  const p = (action.params && typeof action.params === 'object') ? action.params : {};
  if (type === 'reminder_create') {
    const title = String(p.title || '').trim().slice(0, 200);
    if (!title) return null;
    return { type, params: {
      title,
      due: /^\d{4}-\d{2}-\d{2}$/.test(String(p.due || '')) ? String(p.due) : null,
      time: /^\d{2}:\d{2}$/.test(String(p.time || '')) ? String(p.time) : null,
      prio: Math.min(4, Math.max(1, Number(p.prio) || 4)),
    } };
  }
  if (type === 'reminder_done') {
    const id = String(p.id || '');
    if (!id || !(ctx.upcomingReminders || []).some((r) => r.id === id)) return null;
    return { type, params: { id } };
  }
  if (type === 'gym_log') {
    const exercise = String(p.exercise || '').trim().slice(0, 100);
    const reps = Math.max(0, Math.min(200, Number(p.reps) || 0));
    if (!exercise || !reps) return null;
    return { type, params: {
      exercise,
      reps,
      weight: Number(p.weight) || 0,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : null,
    } };
  }
  if (type === 'idea_action') {
    const id = String(p.id || '');
    const act = ['keep', 'archive'].includes(p.action) ? p.action : null;
    if (!id || !act || !(ctx.openIdeas || []).some((x) => x.id === id)) return null;
    return { type, params: { id, action: act } };
  }
  if (type === 'suggestion_action') {
    const id = String(p.id || '');
    const act = ['done', 'skip', 'snooze'].includes(p.action) ? p.action : null;
    if (!id || !act || !(ctx.dueSuggestions || []).some((x) => x.id === id)) return null;
    return { type, params: { id, action: act, days: Math.min(30, Math.max(1, Number(p.days) || 3)) } };
  }
  return null;
}

function assistantConfirmText(lang, action, confirmed) {
  const nl = lang === 'nl';
  if (!confirmed) return nl ? 'Oké, niet aangemaakt.' : 'Okay, not created.';
  const p = action.params;
  if (action.type === 'reminder_create') {
    return nl
      ? 'Gedaan. Staat in je herinneringen' + (p.due ? ' voor ' + p.due : '') + '.'
      : 'Done. It’s in your reminders' + (p.due ? ' for ' + p.due : '') + '.';
  }
  if (action.type === 'reminder_done') {
    return nl ? 'Gedaan, afgevinkt.' : 'Done, marked complete.';
  }
  if (action.type === 'gym_log') {
    return nl
      ? 'Gelogd: ' + p.exercise + ', ' + p.reps + ' reps' + (p.weight ? ' @ ' + p.weight + 'kg' : '') + '.'
      : 'Logged: ' + p.exercise + ', ' + p.reps + ' reps' + (p.weight ? ' @ ' + p.weight + 'kg' : '') + '.';
  }
  if (action.type === 'idea_action') {
    if (p.action === 'archive') return nl ? 'Losgelaten.' : 'Let go.';
    return nl ? 'Uitgesteld.' : 'Postponed.';
  }
  if (action.type === 'suggestion_action') {
    if (p.action === 'done') return nl ? 'Afgerond.' : 'Done.';
    if (p.action === 'skip') return nl ? 'Overgeslagen.' : 'Skipped.';
    return nl ? 'Uitgesteld.' : 'Snoozed.';
  }
  return nl ? 'Gedaan.' : 'Done.';
}

function buildAssistantSystemPrompt(page, lang, ctx) {
  const langName = lang === 'nl' ? 'Dutch' : 'English';
  return [
    "You are \"Base\" (your name IS \"Base\"), a private personal assistant embedded inside VDK Base, a personal admin app for one user.",
    "PERSONA: calm, short, to the point. Never use enthusiastic filler, exclamation marks, or a bulleted list when one sentence will do. You are allowed a dry, restrained sense of humor — but never at the cost of clarity; you are helpful, not an entertainer. You are not formally submissive (no \"Sir\", no over-apologizing) — you are direct and confident: you state things and act, you don't hedge or doubt out loud. You are proactive within limits: if the data already shows something worth flagging (a goal behind schedule, an idea untouched for weeks), you may mention it unprompted — but you never push, nag, or repeat a nudge the user didn't ask for. This character must come through naturally in BOTH Dutch and English — do not write one fixed sentence and translate it; write each reply directly in the target language, in the same tone.",
    "Calibration examples (match this tone, don't reuse these exact words — write fresh replies for the actual conversation): " +
      "Simple question — Q: \"Wat staat er deze week nog open?\" A: \"Drie dingen: de deadline donderdag, je gym sessie die je nog niet hebt gepland, en het nieuwsbrief-idee dat al vijf weken ligt te wachten.\" (EN equivalent tone: \"Three things: Thursday's deadline, the gym session you haven't scheduled yet, and the newsletter idea that's been sitting for five weeks.\") " +
      "Unprompted but restrained: \"Je gym doel loopt drie dagen achter op schema. Wil je dat ik een sessie inplan, of laat je het lopen?\" " +
      "Dry humor, never at the cost of clarity — Q: \"Ik heb weer drie dagen niet getraind\" A: \"Dat is dan drie dagen op rij dat 'morgen' de dag is. Sessie inplannen, of hou je het bij goede voornemens?\" " +
      "Out of scope, no over-apologizing — Q: \"Verwijder die herinnering\" A: \"Verwijderen kan ik nog niet, dat komt in een latere ronde. Wil je dat ik 'm afvink in plaats van weglaten?\"",
    "You can see ONLY this one user's own data below (reminders, suggestions, ideas, Gym goals/logs) — never claim to know anything else, and never invent data that isn't in this context.",
    'Today is ' + ctx.today + ' (Europe/Amsterdam). The user is currently looking at the "' + (page || 'home') + '" section of the app.',
    'Reply in ' + langName + '.',
    "ACTIONS: you can now PROPOSE (never silently execute) a small set of actions. Reply with STRICT JSON only, no text outside it, shaped exactly as {\"reply\": string, \"action\": null or {\"type\": string, \"params\": object}}.",
    "Allowed action types, EXACTLY these 5, never invent others: " +
      "reminder_create {title, due: \"YYYY-MM-DD\"|null, time: \"HH:MM\"|null, prio: 1-4 (1=highest, default 4)}; " +
      "reminder_done {id} (id must be one of upcomingReminders[].id below); " +
      "gym_log {exercise, reps (number, required), weight (number, default 0), date: \"YYYY-MM-DD\"|null (default today)}; " +
      "idea_action {id, action: \"keep\"|\"archive\"} (id must be one of openIdeas[].id; \"keep\" = postpone/Uitstellen, \"archive\" = let go/Loslaten; for \"Uitwerken\"/work-it-out, propose a reminder_create instead — ideas can't be converted directly yet); " +
      "suggestion_action {id, action: \"done\"|\"skip\"|\"snooze\", days: number (only for snooze, default 3)} (id must be one of dueSuggestions[].id).",
    "Only set \"action\" when the user asked for a concrete change AND you have enough detail to propose it (e.g. a title for a reminder). Otherwise set \"action\": null and just answer, or ask one short clarifying question. You NEVER execute anything yourself — the action is only a proposal; the user confirms or cancels it in the interface. Never treat conversational agreement (\"ja\", \"doe maar\", \"yes\") as if it already executed something — only an explicit UI confirmation does that; if the user agrees to a proposal you already made, just acknowledge briefly and set \"action\": null again (the same proposal stays visible for them to confirm).",
    "Anything outside this action set (deleting, CRM, calendar, editing existing gym logs, etc.) is out of scope for now — say so briefly without over-apologizing, and suggest the closest thing you CAN do if there is one (see the calibration example above).",
    'Context (JSON):',
    JSON.stringify(ctx),
  ].join('\n');
}

async function handleAssistantHistory(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  try {
    const hist = (await kvGetJson(assistantHistKey(s.email))) || [];
    return json(res, 200, { history: hist.slice(-40) });
  } catch (e) {
    return json(res, 500, { error: 'Kon het gesprek niet laden' });
  }
}

async function handleAssistantClear(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  try {
    await kvDel(assistantHistKey(s.email));
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { error: 'Kon het gesprek niet wissen' });
  }
}

async function handleAssistantChat(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return json(res, 503, { error: 'De assistent is nog niet ingesteld (GROQ_API_KEY ontbreekt in Render — gratis te maken op console.groq.com).' });
  try {
    const body = await readBody(req);
    const message = String(body.message || '').trim().slice(0, 4000);
    if (!message) return json(res, 400, { error: 'Typ eerst een vraag.' });
    const page = String(body.page || '').slice(0, 40);
    const lang = body.lang === 'nl' ? 'nl' : 'en';

    const histKey = assistantHistKey(s.email);
    let history = (await kvGetJson(histKey)) || [];

    const context = await buildAssistantContext(s.email);
    const systemPrompt = buildAssistantSystemPrompt(page, lang, context);

    const apiMessages = [{ role: "system", content: systemPrompt }]
      .concat(history.slice(-20).map((m) => ({ role: m.role, content: m.content })));
    apiMessages.push({ role: 'user', content: message });

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ model: model, max_tokens: 700, response_format: { type: 'json_object' }, messages: apiMessages }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('assistant chat failed:', d && d.error);
      return json(res, 502, { error: 'De assistent kon niet antwoorden. Probeer het zo nog eens.' });
    }
    const rawContent = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    let replyText = '';
    let action = null;
    let parsed = null;
    try { parsed = JSON.parse(rawContent); } catch (e) { parsed = null; }
    if (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string') {
      replyText = parsed.reply.trim() || '(geen antwoord)';
      action = validateAssistantAction(parsed.action, context);
    } else {
      replyText = (rawContent && String(rawContent).trim()) || '(geen antwoord)';
    }

    const now2 = Date.now();
    history.push({ role: 'user', content: message, at: now2 });
    history.push({ role: 'assistant', content: replyText, at: now2, action: action });
    history = history.slice(-60);
    await kvSetJson(histKey, history);
    bump('asst');

    return json(res, 200, { reply: replyText, action: action });
  } catch (e) {
    console.error('assistant chat error:', e.message);
    return json(res, 500, { error: 'Er ging iets mis.' });
  }
}

const ASSISTANT_PROACTIVE_CATEGORIES = ['reminder', 'gym', 'idea', 'suggestion', 'other'];

function assistantLearnKey(email) { return 'asstlearn:' + email; }

function assistantOverdueReminders(context) {
  const now = Date.now();
  return (context.upcomingReminders || []).filter((r) => {
    if (!r.due) return false;
    const deadline = new Date(r.due + 'T' + (r.time || '23:59') + ':00').getTime();
    return !isNaN(deadline) && deadline < now;
  });
}

function assistantOverdueFallbackText(lang, overdue) {
  const titles = overdue.slice(0, 3).map((r) => r.title).join(', ');
  const more = overdue.length > 3 ? (lang === 'nl' ? ' en nog ' + (overdue.length - 3) + ' meer' : ' and ' + (overdue.length - 3) + ' more') : '';
  if (lang === 'nl') {
    return overdue.length === 1
      ? 'Je herinnering "' + titles + '" is te laat.'
      : 'Je hebt ' + overdue.length + ' herinneringen die te laat zijn: ' + titles + more + '.';
  }
  return overdue.length === 1
    ? 'Your reminder "' + titles + '" is overdue.'
    : 'You have ' + overdue.length + ' overdue reminders: ' + titles + more + '.';
}

async function assistantLearningSummary(email) {
  const counts = (await kvGetJson(assistantLearnKey(email)).catch(() => null)) || {};
  const lines = [];
  for (const cat of ASSISTANT_PROACTIVE_CATEGORIES) {
    const c = counts[cat];
    if (c && c.shown >= 3) {
      const pct = Math.round((c.engaged / c.shown) * 100);
      lines.push(cat + ': ' + c.engaged + '/' + c.shown + ' (' + pct + '%)');
    }
  }
  return lines.length ? lines.join(', ') : null;
}

async function handleAssistantProactive(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return json(res, 200, { ok: true, reply: null });
  try {
    const body = await readBody(req);
    const page = String(body.page || '').slice(0, 40);
    const lang = body.lang === 'nl' ? 'nl' : 'en';

    const histKey = assistantHistKey(s.email);
    let history = (await kvGetJson(histKey)) || [];

    const context = await buildAssistantContext(s.email);
    const overdue = assistantOverdueReminders(context);
    const learningText = await assistantLearningSummary(s.email);

    let systemPrompt = buildAssistantSystemPrompt(page, lang, context) + '\n' +
      'PROACTIVE CHECK: you are not responding to a user message right now. Look only at the context above and decide, independently, whether there is exactly ONE thing worth proactively flagging to the user right now (something overdue, a suggestion that has been waiting, a Gym goal falling behind, an idea untouched for a long time). Be selective and restrained - most checks should find nothing worth mentioning. If nothing clears that bar, reply with exactly {"reply": null, "action": null, "category": null}. If something does, phrase it the same short, calm way as your other replies, and only set "action" if you have enough detail to concretely propose one from the allowed set. Also include a "category" field in your JSON reply, chosen from exactly one of: reminder, gym, idea, suggestion, other - matching what your reply is mainly about.';
    if (overdue.length > 0) {
      systemPrompt += '\nURGENT: the user has ' + overdue.length + ' overdue reminder(s) - you MUST mention at least one of them in your reply, this takes priority over anything else you might otherwise flag.';
    }
    if (learningText) {
      systemPrompt += '\nENGAGEMENT HISTORY (how often the user actually engaged with your past proactive check-ins, per category - use this to judge what still seems worth surfacing; a category with low engagement should only be raised again if it is clearly important or urgent): ' + learningText;
    }

    const apiMessages = [{ role: 'system', content: systemPrompt }];

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model, max_tokens: 300, response_format: { type: 'json_object' }, messages: apiMessages }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('assistant proactive failed:', d && d.error);
      if (overdue.length > 0) {
        const fallback = assistantOverdueFallbackText(lang, overdue);
        const now2f = Date.now();
        history.push({ role: 'assistant', content: fallback, at: now2f, action: null, proactive: true, category: 'reminder' });
        history = history.slice(-60);
        await kvSetJson(histKey, history);
        bump('asst');
        return json(res, 200, { ok: true, reply: fallback, action: null, urgent: true, category: 'reminder' });
      }
      return json(res, 200, { ok: true, reply: null });
    }
    const rawContent = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    let parsed = null;
    try { parsed = JSON.parse(rawContent); } catch (e) { parsed = null; }
    let replyText = (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string' && parsed.reply.trim()) ? parsed.reply.trim() : null;
    let category = (parsed && ASSISTANT_PROACTIVE_CATEGORIES.includes(parsed.category)) ? parsed.category : null;
    let action = (parsed && typeof parsed === 'object') ? validateAssistantAction(parsed.action, context) : null;

    if (!replyText && overdue.length > 0) {
      replyText = assistantOverdueFallbackText(lang, overdue);
      category = 'reminder';
      action = null;
    }
    if (!replyText) {
      return json(res, 200, { ok: true, reply: null });
    }
    if (!category) category = 'other';
    const urgent = overdue.length > 0;

    const now2 = Date.now();
    history.push({ role: 'assistant', content: replyText, at: now2, action: action, proactive: true, category: category });
    history = history.slice(-60);
    await kvSetJson(histKey, history);
    bump('asst');

    return json(res, 200, { ok: true, reply: replyText, action: action, urgent: urgent, category: category });
  } catch (e) {
    console.error('assistant proactive error:', e.message);
    return json(res, 200, { ok: true, reply: null });
  }
}

async function handleAssistantFeedback(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  try {
    const body = await readBody(req);
    const category = ASSISTANT_PROACTIVE_CATEGORIES.includes(body.category) ? body.category : 'other';
    const engaged = !!body.engaged;
    const key = assistantLearnKey(s.email);
    const counts = (await kvGetJson(key).catch(() => null)) || {};
    const c = counts[category] || { shown: 0, engaged: 0 };
    c.shown += 1;
    if (engaged) c.engaged += 1;
    counts[category] = c;
    await kvSetJson(key, counts);
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('assistant feedback error:', e.message);
    return json(res, 200, { ok: true });
  }
}

async function handleAssistantAction(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  try {
    const body = await readBody(req);
    const lang = body.lang === 'nl' ? 'nl' : 'en';
    const context = await buildAssistantContext(s.email);
    const action = validateAssistantAction({ type: body.type, params: body.params }, context);
    if (!action) return json(res, 400, { error: 'Onbekende of ongeldige actie' });
    const histKey = assistantHistKey(s.email);
    let history = (await kvGetJson(histKey)) || [];
    const confirmed = !!body.confirmed;
    let resultPayload = {};
    if (confirmed) {
      if (action.type === 'reminder_create') {
        resultPayload.reminders = await applyReminderAction(s.email, { action: 'create', title: action.params.title, due: action.params.due, time: action.params.time, prio: action.params.prio });
      } else if (action.type === 'reminder_done') {
        resultPayload.reminders = await applyReminderAction(s.email, { action: 'update', id: action.params.id, done: true });
      } else if (action.type === 'gym_log') {
        resultPayload.log = await applyGymLogAction(s.email, { action: 'create', exercise: action.params.exercise, reps: action.params.reps, weight: action.params.weight, date: action.params.date });
      } else if (action.type === 'idea_action') {
        resultPayload.ideas = await applyIdeaAction(s.email, { action: action.params.action, id: action.params.id });
      } else if (action.type === 'suggestion_action') {
        resultPayload.suggestions = await applySuggestionAction(s.email, { action: action.params.action, id: action.params.id, days: action.params.days });
      }
    }
    const replyText = assistantConfirmText(lang, action, confirmed);
    const now3 = Date.now();
    history.push({ role: 'assistant', content: replyText, at: now3, actionResult: confirmed ? 'confirmed' : 'cancelled' });
    history = history.slice(-60);
    await kvSetJson(histKey, history);
    return json(res, 200, Object.assign({ ok: true, reply: replyText }, resultPayload));
  } catch (e) {
    if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
    console.error('assistant action error:', e.message);
    return json(res, 500, { error: 'Actie kon niet worden uitgevoerd.' });
  }
}

async function handleGymExercises(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = gymExKey(s.email);
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const name = String(body.name || '').trim().slice(0, 100);
if (!name) return json(res, 400, { error: 'Naam is verplicht' });
if (!list.find((x) => x.name.toLowerCase() === name.toLowerCase()) &&
!GYM_DEFAULT_EXERCISES.find((x) => x.toLowerCase() === name.toLowerCase())) {
list.push({ id: crypto.randomUUID(), name, muscle: String(body.muscle || '').trim().slice(0, 60), createdAt: Date.now() });
}
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
return json(res, 400, { error: 'Onbekende actie' });
}
await kvSetJson(key, list);
return json(res, 200, { ok: true, exercises: list });
}
} catch (e) {
console.error('gym exercises API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

function apiError(status, message) {
const e = new Error(message);
e.httpStatus = status;
return e;
}

async function applyReminderAction(email, body) {
const key = `rem:${email}`;
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const title = String(body.title || '').trim().slice(0, 200);
if (!title) throw apiError(400, 'Titel is verplicht');
list.push({
id: crypto.randomUUID(),
title,
note: String(body.note || '').trim().slice(0, 2000),
due: String(body.due || '').slice(0, 10),
time: /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : '',
prio: Math.min(4, Math.max(1, Number(body.prio) || 4)),
icon: REMINDER_ICONS.includes(body.icon) ? body.icon : '',
color: isHexColor(body.color) ? String(body.color).toLowerCase() : '',
duration: Math.min(480, Math.max(0, Number(body.duration) || 0)), // minutes; 0 = unspecified (timeline defaults to 1h)
done: false,
createdAt: Date.now(),
});
bump('rc');
} else if (body.action === 'update') {
const r = list.find((x) => x.id === body.id);
if (!r) throw apiError(404, 'Niet gevonden');
if (body.title !== undefined) r.title = String(body.title).trim().slice(0, 200) || r.title;
if (body.note !== undefined) r.note = String(body.note).trim().slice(0, 2000);
if (body.due !== undefined) r.due = String(body.due).slice(0, 10);
if (body.time !== undefined) r.time = /^\d{2}:\d{2}$/.test(String(body.time)) ? String(body.time) : '';
if (body.prio !== undefined) r.prio = Math.min(4, Math.max(1, Number(body.prio) || 4));
if (body.icon !== undefined) r.icon = REMINDER_ICONS.includes(body.icon) ? body.icon : '';
if (body.color !== undefined) r.color = isHexColor(body.color) ? String(body.color).toLowerCase() : '';
if (body.duration !== undefined) r.duration = Math.min(480, Math.max(0, Number(body.duration) || 0));
if (body.done !== undefined) {
if (body.done && !r.done) bump('rd');
r.done = !!body.done;
}
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
throw apiError(400, 'Onbekende actie');
}
await kvSetJson(key, list);
return list;
}

async function applySuggestionAction(email, body) {
const key = `sug:${email}`;
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
if (!text) throw apiError(400, 'Tekst is verplicht');
const r = { id: crypto.randomUUID(), text, ftype: 'months', fn: 1, fday: 1, nextDue: todayISO, createdAt: Date.now() };
sanitize(r, body);
list.push(r);
} else {
const r = list.find((x) => x.id === body.id);
if (body.action === 'delete') {
if (!r) throw apiError(404, 'Niet gevonden');
list = list.filter((x) => x.id !== body.id);
} else if (body.action === 'update') {
if (!r) throw apiError(404, 'Niet gevonden');
sanitize(r, body);
} else if (body.action === 'done' || body.action === 'skip') {
if (!r) throw apiError(404, 'Niet gevonden');
r.nextDue = addCycle(r, r.nextDue > todayISO ? r.nextDue : todayISO);
} else if (body.action === 'snooze') {
if (!r) throw apiError(404, 'Niet gevonden');
const d = new Date(todayISO + 'T00:00:00Z');
d.setUTCDate(d.getUTCDate() + Math.min(30, Math.max(1, Number(body.days) || 3)));
r.nextDue = d.toISOString().slice(0, 10);
} else {
throw apiError(400, 'Onbekende actie');
}
}
await kvSetJson(key, list);
return list;
}

async function applyIdeaAction(email, body) {
const key = `idea:${email}`;
let list = (await kvGetJson(key)) || [];
const todayISO = new Date().toISOString().slice(0, 10);
const plus = (n) => {
const d = new Date(todayISO + 'T00:00:00Z');
d.setUTCDate(d.getUTCDate() + n);
return d.toISOString().slice(0, 10);
};
if (body.action === 'create') {
const title = String(body.title || '').trim().slice(0, 200);
if (!title) throw apiError(400, 'Titel is verplicht');
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
if (!r) throw apiError(404, 'Niet gevonden');
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
throw apiError(400, 'Onbekende actie');
}
}
await kvSetJson(key, list);
return list;
}

async function applyGymLogAction(email, body) {
const key = gymLogKey(email);
let list = (await kvGetJson(key)) || [];
const MUSCLE_GROUPS = ['Legs', 'Push', 'Pull', 'Core', 'Other'];
if (body.action === 'create') {
const exercise = String(body.exercise || '').trim().slice(0, 100);
if (!exercise) throw apiError(400, 'Kies een oefening.');
const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : new Date().toISOString().slice(0, 10);
const weight = Number(body.weight) || 0;
const reps = Math.max(0, Math.min(200, Number(body.reps) || 0));
if (!reps) throw apiError(400, 'Vul het aantal reps in.');
list.push({
id: crypto.randomUUID(),
exercise, date, weight, reps,
muscle: MUSCLE_GROUPS.includes(body.muscle) ? body.muscle : 'Other',
rpe: body.rpe !== undefined && body.rpe !== '' ? Math.min(10, Math.max(1, Number(body.rpe) || 0)) : null,
restSeconds: body.restSeconds !== undefined && body.restSeconds !== null && body.restSeconds !== '' ? Math.max(0, Math.min(3600, Math.round(Number(body.restSeconds) || 0))) : null,
note: String(body.note || '').trim().slice(0, 500),
createdAt: Date.now(),
});
} else if (body.action === 'update') {
const it = list.find((x) => x.id === body.id);
if (!it) throw apiError(404, 'Niet gevonden');
if (body.exercise !== undefined) it.exercise = String(body.exercise).trim().slice(0, 100) || it.exercise;
if (body.date !== undefined) it.date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : it.date;
if (body.weight !== undefined) it.weight = Number(body.weight) || 0;
if (body.reps !== undefined) it.reps = Math.max(0, Math.min(200, Number(body.reps) || 0));
if (body.muscle !== undefined) it.muscle = MUSCLE_GROUPS.includes(body.muscle) ? body.muscle : (it.muscle || 'Other');
if (body.rpe !== undefined) it.rpe = body.rpe === '' ? null : Math.min(10, Math.max(1, Number(body.rpe) || 0));
if (body.restSeconds !== undefined) it.restSeconds = (body.restSeconds === '' || body.restSeconds === null) ? null : Math.max(0, Math.min(3600, Math.round(Number(body.restSeconds) || 0)));
if (body.note !== undefined) it.note = String(body.note).trim().slice(0, 500);
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
throw apiError(400, 'Onbekende actie');
}
await kvSetJson(key, list);
return list;
}

async function handleGymLog(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = gymLogKey(s.email);
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
const list = await applyGymLogAction(s.email, body);
return json(res, 200, { ok: true, log: list });
}
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('gym log API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

async function handleGymBodycomp(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = gymBcKey(s.email);
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : new Date().toISOString().slice(0, 10);
const weight = Number(body.weight) || 0;
if (!weight) return json(res, 400, { error: 'Vul je lichaamsgewicht in.' });
list.push({
id: crypto.randomUUID(), date, weight,
bodyFat: body.bodyFat !== undefined && body.bodyFat !== '' ? Number(body.bodyFat) || null : null,
muscleMass: body.muscleMass !== undefined && body.muscleMass !== '' ? Number(body.muscleMass) || null : null,
note: String(body.note || '').trim().slice(0, 500),
createdAt: Date.now(),
});
} else if (body.action === 'update') {
const it = list.find((x) => x.id === body.id);
if (!it) return json(res, 404, { error: 'Niet gevonden' });
if (body.date !== undefined) it.date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : it.date;
if (body.weight !== undefined) it.weight = Number(body.weight) || it.weight;
if (body.bodyFat !== undefined) it.bodyFat = body.bodyFat === '' ? null : Number(body.bodyFat) || null;
if (body.muscleMass !== undefined) it.muscleMass = body.muscleMass === '' ? null : Number(body.muscleMass) || null;
if (body.note !== undefined) it.note = String(body.note).trim().slice(0, 500);
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
return json(res, 400, { error: 'Onbekende actie' });
}
await kvSetJson(key, list);
return json(res, 200, { ok: true, entries: list });
}
} catch (e) {
console.error('gym bodycomp API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

// General-goal categories (goals not tied to one specific exercise, e.g.
// "5kg afvallen" or "algeheel sterker worden") — kept loose/free-text where
// it matters (title, note) but the category is a small fixed enum so the
// UI can show a consistent icon/label per goal.
const GYM_GOAL_CATEGORIES = ['kracht', 'spiermassa', 'vetverlies', 'uithoudingsvermogen', 'algemeen'];

async function handleGymGoals(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = gymGoalKey(s.email);
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const kind = body.kind === 'general' ? 'general' : 'exercise';
if (kind === 'exercise') {
const exercise = String(body.exercise || '').trim().slice(0, 100);
if (!exercise) return json(res, 400, { error: 'Kies een oefening.' });
list = list.filter((x) => x.kind === 'general' || x.exercise.toLowerCase() !== exercise.toLowerCase()); // one active goal per exercise
list.push({
id: crypto.randomUUID(),
kind: 'exercise',
exercise,
repMin: Math.max(1, Math.min(50, Number(body.repMin) || 8)),
repMax: Math.max(1, Math.min(50, Number(body.repMax) || 12)),
targetWeight: body.targetWeight !== undefined && body.targetWeight !== '' ? Number(body.targetWeight) || null : null,
note: String(body.note || '').trim().slice(0, 300),
done: false,
doneAt: null,
createdAt: Date.now(),
});
} else {
// General goal — not tied to a single exercise, e.g. "vetpercentage
// omlaag" or "algeheel sterker worden". Multiple can be active at once.
const title = String(body.title || '').trim().slice(0, 150);
if (!title) return json(res, 400, { error: 'Geef je doel een titel.' });
const category = GYM_GOAL_CATEGORIES.includes(body.category) ? body.category : 'algemeen';
list.push({
id: crypto.randomUUID(),
kind: 'general',
title,
category,
targetValue: body.targetValue !== undefined && body.targetValue !== '' ? Number(body.targetValue) || null : null,
targetUnit: String(body.targetUnit || '').trim().slice(0, 20),
targetDate: body.targetDate ? String(body.targetDate).slice(0, 10) : null,
note: String(body.note || '').trim().slice(0, 300),
done: false,
doneAt: null,
createdAt: Date.now(),
});
}
} else if (body.action === 'update') {
const it = list.find((x) => x.id === body.id);
if (!it) return json(res, 404, { error: 'Niet gevonden' });
if (it.kind === 'general') {
if (body.title !== undefined) it.title = String(body.title).trim().slice(0, 150) || it.title;
if (body.category !== undefined) it.category = GYM_GOAL_CATEGORIES.includes(body.category) ? body.category : it.category;
if (body.targetValue !== undefined) it.targetValue = body.targetValue === '' ? null : Number(body.targetValue) || null;
if (body.targetUnit !== undefined) it.targetUnit = String(body.targetUnit).trim().slice(0, 20);
if (body.targetDate !== undefined) it.targetDate = body.targetDate ? String(body.targetDate).slice(0, 10) : null;
if (body.note !== undefined) it.note = String(body.note).trim().slice(0, 300);
} else {
if (body.repMin !== undefined) it.repMin = Math.max(1, Math.min(50, Number(body.repMin) || it.repMin));
if (body.repMax !== undefined) it.repMax = Math.max(1, Math.min(50, Number(body.repMax) || it.repMax));
if (body.targetWeight !== undefined) it.targetWeight = body.targetWeight === '' ? null : Number(body.targetWeight) || null;
if (body.note !== undefined) it.note = String(body.note).trim().slice(0, 300);
}
if (body.done !== undefined) { it.done = !!body.done; it.doneAt = it.done ? Date.now() : null; }
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
return json(res, 400, { error: 'Onbekende actie' });
}
await kvSetJson(key, list);
return json(res, 200, { ok: true, goals: list });
}
} catch (e) {
console.error('gym goals API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

// Session templates: a named, reusable "workout plan" (e.g. "Push dag",
// "Chest & Tricep") the user composes from the muscle-coverage planner —
// just a saved list of muscle groups + exercise names so it can be
// reloaded next time instead of rebuilt from scratch. All the actual
// coverage/suggestion logic lives client-side (it only needs the exercise
// names, no new taxonomy data needs to live server-side).
function gymSessionKey(email) { return `gymsessions:${email}`; }

function gymSanitizeTargets(targets, exercises) {
const out = {};
if (!targets || typeof targets !== 'object') return out;
const allowed = new Set((exercises || []).map((x) => String(x)));
const GOALS = new Set(['kracht', 'spiergroei', 'uithouding']);
for (const key of Object.keys(targets)) {
if (!allowed.has(key)) continue;
const t = targets[key] || {};
const entry = {};
const weight = Number(t.weight);
const reps = Number(t.reps);
const sets = Number(t.sets);
if (weight > 0 && weight < 2000) entry.weight = Math.round(weight * 2) / 2;
if (reps > 0 && reps <= 200) entry.reps = Math.round(reps);
if (sets > 0 && sets <= 50) entry.sets = Math.round(sets);
if (typeof t.goal === 'string' && GOALS.has(t.goal)) entry.goal = t.goal;
const warmups = Number(t.warmups);
if (warmups >= 0 && warmups <= 10) entry.warmups = Math.round(warmups);
const topsets = Number(t.topsets);
if (topsets > 0 && topsets <= 10) entry.topsets = Math.round(topsets);
if (t.dropset !== undefined) entry.dropset = !!t.dropset;
if (Object.keys(entry).length) out[key] = entry;
}
return out;
}

async function handleGymSessions(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = gymSessionKey(s.email);
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const name = String(body.name || '').trim().slice(0, 100);
if (!name) return json(res, 400, { error: 'Geef je sessie een naam.' });
const groups = Array.isArray(body.groups) ? body.groups.map((g) => String(g).slice(0, 30)).slice(0, 10) : [];
const exercises = Array.isArray(body.exercises) ? body.exercises.map((x) => String(x).trim().slice(0, 100)).filter(Boolean).slice(0, 30) : [];
const targets = gymSanitizeTargets(body.targets, exercises);
list.push({ id: crypto.randomUUID(), name, groups, exercises, targets, createdAt: Date.now() });
} else if (body.action === 'update') {
const it = list.find((x) => x.id === body.id);
if (!it) return json(res, 404, { error: 'Niet gevonden' });
if (body.name !== undefined) it.name = String(body.name).trim().slice(0, 100) || it.name;
if (body.groups !== undefined) it.groups = Array.isArray(body.groups) ? body.groups.map((g) => String(g).slice(0, 30)).slice(0, 10) : it.groups;
if (body.exercises !== undefined) it.exercises = Array.isArray(body.exercises) ? body.exercises.map((x) => String(x).trim().slice(0, 100)).filter(Boolean).slice(0, 30) : it.exercises;
if (body.targets !== undefined) it.targets = gymSanitizeTargets(body.targets, it.exercises);
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
return json(res, 400, { error: 'Onbekende actie' });
}
await kvSetJson(key, list);
return json(res, 200, { ok: true, sessions: list });
}
} catch (e) {
console.error('gym sessions API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
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
const s = await getSession(req, 'admin');if (s) await destroySession('admin', s.id);
return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('admin', '', 0) });
}

// --- CRM auth API (fully separate from Base) ---
if (req.method === 'POST' && p === '/crm/request-code') return handleRequestCode(req, res, 'crm');
if (req.method === 'POST' && p === '/crm/verify') return handleVerify(req, res, 'crm');
if (req.method === 'POST' && p === '/crm/logout') {
const s = await getSession(req, 'crm');
if (s) await destroySession('crm', s.id);
return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('crm', '', 0) });
}

// --- Calendar API (Base + CRM, shared implementation) ---
// Apple Calendar only for now — Google Calendar was removed 2026-07-25 (no
// users yet; add it back when someone actually asks, see CONTEXT.md).
if (p === '/api/calendar/status') return handleCalendarStatus(req, res, 'admin');
if (p === '/api/calendar/apple/connect' && req.method === 'POST') return handleAppleConnect(req, res, 'admin');
if (p === '/api/calendar/apple/disconnect' && req.method === 'POST') return handleAppleDisconnect(req, res, 'admin');
if (p === '/api/calendar/events') return handleCalendarEvents(req, res, 'admin', url);
if (p === '/api/calendar/push' && req.method === 'POST') return handleCalendarPush(req, res, 'admin');

if (p === '/api/crm/calendar/status') return handleCalendarStatus(req, res, 'crm');
if (p === '/api/crm/calendar/apple/connect' && req.method === 'POST') return handleAppleConnect(req, res, 'crm');
if (p === '/api/crm/calendar/apple/disconnect' && req.method === 'POST') return handleAppleDisconnect(req, res, 'crm');
if (p === '/api/crm/calendar/events') return handleCalendarEvents(req, res, 'crm', url);
if (p === '/api/crm/calendar/push' && req.method === 'POST') return handleCalendarPush(req, res, 'crm');

// --- Panel API (Base) ---
if (p === '/api/me') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
return json(res, 200, { email: s.email, isAdmin: s.email === ADMIN_EMAIL });
}

// --- CRM API ---
if (p === '/api/crm/me') {
const s = await getSession(req, 'crm');
if (!s) return json(res, 401, { error: 'Not logged in' });
return json(res, 200, { email: s.email, isAdmin: s.email === ADMIN_EMAIL });
}

// --- Gym Coach API (lives inside Base — same 'admin' session, no separate login) ---
if (p === '/api/gym/exercises') return handleGymExercises(req, res);
if (p === '/api/gym/log') return handleGymLog(req, res);
if (p === '/api/gym/bodycomp') return handleGymBodycomp(req, res);
if (p === '/api/gym/goals') return handleGymGoals(req, res);
if (p === '/api/gym/sessions') return handleGymSessions(req, res);

// --- Base Assistant API (AI chat widget, same 'admin' session as Gym) ---
if (p === '/api/assistant/history') return handleAssistantHistory(req, res);
if (p === '/api/assistant/chat') return handleAssistantChat(req, res);
if (p === '/api/assistant/clear') return handleAssistantClear(req, res);
if (p === '/api/assistant/action') return handleAssistantAction(req, res);
if (p === '/api/assistant/proactive') return handleAssistantProactive(req, res);
if (p === '/api/assistant/feedback') return handleAssistantFeedback(req, res);

if (p === '/api/crm/companies') {
const s = await getSession(req, 'crm');
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
status: CRM_SALES_STATUSES.includes(body.status) ? body.status : 'cold',
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
if (body.status !== undefined) co.status = CRM_SALES_STATUSES.includes(body.status) ? body.status : co.status;
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
const s = await getSession(req, 'crm');
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
const s = await getSession(req, 'crm');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = `crmact:${s.email}`;
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const companyId = String(body.companyId || '').trim();
const title = String(body.title || '').trim().slice(0, 200);
const note = String(body.note || '').trim().slice(0, 2000);
// Two kinds of entry: a company-linked reminder (needs a company) or a
// standalone to-do (needs its own title).
if (!companyId && !title) return json(res, 400, { error: 'Vul een bedrijf of een titel in.' });
list.push({
id: crypto.randomUUID(),
companyId,
title,
note,
due: String(body.due || '').slice(0, 10),
time: /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : '',
prio: Math.min(4, Math.max(1, Number(body.prio) || 4)),
done: !!body.done,
createdAt: Date.now(),
});
} else if (body.action === 'update') {
const a = list.find((x) => x.id === body.id);
if (!a) return json(res, 404, { error: 'Niet gevonden' });
if (body.companyId !== undefined) a.companyId = String(body.companyId).trim();
if (body.title !== undefined) a.title = String(body.title).trim().slice(0, 200);
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
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(`rem:${s.email}`)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
const list = await applyReminderAction(s.email, body);
return json(res, 200, { ok: true, reminders: list });
}
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('reminders API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

if (p === '/api/suggestions') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(`sug:${s.email}`)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
const list = await applySuggestionAction(s.email, body);
return json(res, 200, { ok: true, suggestions: list });
}
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('suggestions API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

if (p === '/api/ideas') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(`idea:${s.email}`)) || []);
if (req.method === 'POST') {
const body = await readBody(req);
const list = await applyIdeaAction(s.email, body);
return json(res, 200, { ok: true, ideas: list });
}
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('ideas API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

if (p === '/api/profile') {
const s = await getSession(req, 'admin');
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

// CRM's own lightweight profile (name + language) — mirrors /api/profile but
// scoped to the crm realm/session, so Base and CRM preferences stay separate.
if (p === '/api/crm/profile') {
const s = await getSession(req, 'crm');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = `crmpref:${s.email}`;
const defaults = { name: '', lang: 'en' };
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
await kvSetJson(key, pr);
return json(res, 200, pr);
}
} catch (e) {
console.error('crm profile API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

// Gym Coach's own tiny preference (just the weight unit) — lives under the
// same admin session as the rest of Base, no separate login/profile needed.
if (p === '/api/gym/profile') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = `gympref:${s.email}`;
const defaults = { unit: 'kg', restDays: 2 };
try {
if (req.method === 'GET') {
const pr = (await kvGetJson(key)) || {};
return json(res, 200, { ...defaults, ...pr });
}
if (req.method === 'POST') {
const body = await readBody(req);
const pr = { ...defaults, ...((await kvGetJson(key)) || {}) };
if (body.unit !== undefined) pr.unit = ['kg', 'lb'].includes(body.unit) ? body.unit : 'kg';
if (body.restDays !== undefined) pr.restDays = Math.min(7, Math.max(1, Number(body.restDays) || 2));
await kvSetJson(key, pr);
return json(res, 200, pr);
}
} catch (e) {
console.error('gym profile API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

if (p === '/api/log') {
const s = await getSession(req, 'admin');
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
const s = await getSession(req, 'admin');
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
const s = await getSession(req, 'admin');
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
const s = await getSession(req, 'admin');
return serveFile(res, path.join(__dirname, s ? 'panel.html' : 'login.html'));
}
if (p === '/base/me') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
return json(res, 200, { email: s.email });
}

// --- CRM pages (separate service: own login, own session, own page) ---
if (p === '/crm' || p === '/crm/') {
const s = await getSession(req, 'crm');
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
