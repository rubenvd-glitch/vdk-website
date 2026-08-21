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

// H-03: elke headerwaarde wordt van regeleindes ontdaan voordat hij in het
// bericht belandt, en de body krijgt dot-stuffing zodat een regel die met een
// punt begint de DATA-fase niet vroegtijdig afsluit.
const message = [
`From: VDK Business Services <${stripCrlf(from)}>`,
`To: <${stripCrlf(to)}>`,
`Subject: ${stripCrlf(subject)}`,
`Date: ${new Date().toUTCString()}`,
`Message-ID: <${crypto.randomUUID()}@vdkbusiness-services.nl>`,
'MIME-Version: 1.0',
'Content-Type: text/plain; charset=utf-8',
'',
text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
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

// Een misvormd cookie-paar wordt overgeslagen in plaats van verkeerd geparsed.
function parseCookies(header) {
const out = {};
for (const part of String(header || '').split(';')) {
const i = part.indexOf('=');
if (i === -1) continue;
const k = part.slice(0, i).trim();
if (k) out[k] = part.slice(i + 1).trim();
}
return out;
}

async function getSession(req, realm) {
const cookieName = REALM_COOKIE[realm];
if (!cookieName) return null;
const raw = parseCookies(req.headers.cookie)[cookieName];
if (!raw) return null;
const dot = raw.lastIndexOf('.');
if (dot <= 0) return null;
const id = raw.slice(0, dot);
const sig = raw.slice(dot + 1);
// C-01: vergelijk BYTE-lengtes, nooit string-lengtes. Bij een multi-byte teken
// lopen die twee uiteen, en dan gooit timingSafeEqual een RangeError die het
// hele proces meenam.
const sigBuf = Buffer.from(sig, 'utf8');
const expBuf = Buffer.from(sign(id), 'utf8');
if (sigBuf.length !== expBuf.length) return null;
if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
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

// M-03/L-01: achter Render staat altijd een proxy, dus req.socket.remoteAddress
// is het adres van die proxy en zou alle bezoekers in dezelfde emmer stoppen.
// X-Forwarded-For is alleen te vertrouwen als er zo'n proxy voor staat die de
// header overschrijft; vandaar aan in productie, uit lokaal, met TRUST_PROXY
// als expliciete override.
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === 'true' : IS_PROD;
function clientIp(req) {
if (TRUST_PROXY) {
const xff = req.headers['x-forwarded-for'];
if (typeof xff === 'string' && xff) {
const first = xff.split(',')[0].trim();
if (first) return first;
}
}
return req.socket.remoteAddress || 'onbekend';
}

// Emmers per sleutel in plaats van alleen per IP. De inlogflow gebruikt er twee:
// op IP en op e-mailadres, zodat een gedeeld IP niet iedereen buitensluit en een
// enkel account niet vanaf wisselende adressen te bestoken is.
function allowRate(key, limit = 10, windowMs = 15 * 60 * 1000) {
const now = Date.now();
const e = rateLimit.get(key);
if (!e || now > e.resetAt) { rateLimit.set(key, { count: 1, resetAt: now + windowMs }); return true; }
return ++e.count <= limit;
}

/* ---------- H-03: adresvalidatie en SMTP-headerinjectie ---------- */
// Geen CR/LF, geen komma's, geen puntkomma's: dat zijn precies de tekens
// waarmee je in een SMTP-header extra ontvangers of headers smokkelt.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
function isValidEmail(v) {
const s = String(v == null ? '' : v).trim();
return s.length >= 3 && s.length <= 254 && EMAIL_RE.test(s);
}
// Vangnet vlak voor de transactie zelf, voor het geval er ooit een adres langs
// de validatie komt via een ander pad.
function stripCrlf(v) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim(); }

// ---------- HTTP helpers ----------
// Beveiligingsheaders op elk antwoord. De CSP volgt in een latere commit,
// samen met het omzetten van de inline handlers: een nonce-CSP blokkeert die
// en zonder die omzetting zijn de panelen onbruikbaar.
function securityHeaders() {
const h = {
'X-Content-Type-Options': 'nosniff',
'X-Frame-Options': 'DENY',
'Referrer-Policy': 'no-referrer',
'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
'Cross-Origin-Opener-Policy': 'same-origin',
};
if (IS_PROD) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
return h;
}

function json(res, status, obj, headers = {}) {
const body = JSON.stringify(obj);
res.writeHead(status, {
'Content-Type': 'application/json',
'Cache-Control': 'no-store, max-age=0',
...securityHeaders(),
...headers,
});
res.end(body);
}

function serveFile(res, filePath, status = 200) {
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
'.css': 'text/css', '.js': 'text/javascript', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
fs.readFile(filePath, (err, data) => {
if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders() }); return res.end('Not found'); }
const ext = path.extname(filePath);
// Ingelogde HTML mag nergens blijven staan (terugknop na uitloggen); alleen
// statische afbeeldingen mogen gecachet worden.
const cache = ext === '.html' ? 'no-store, max-age=0' : 'public, max-age=86400';
res.writeHead(status, {
'Content-Type': types[ext] || 'application/octet-stream',
'Cache-Control': cache,
...securityHeaders(),
});
res.end(data);
});
}

// M-06: req.destroy() liet 'end' nooit vuren, dus de promise werd nooit
// afgerond en de handler bleef eeuwig hangen. Nu: 413 terug, null resolven,
// en tellen in bytes in plaats van gedecodeerde tekens.
function readBody(req, res, limit = 10000) {
return new Promise((resolve) => {
const chunks = [];
let len = 0, settled = false;
const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
req.on('data', (c) => {
len += c.length;
if (len > limit) {
req.removeAllListeners('data');
if (res && !res.headersSent) {
// Connection: close, anders probeert de client de socket die we hierna
// vernielen te hergebruiken en krijgt hij een ECONNRESET op het volgende
// verzoek in plaats van dit nette 413-antwoord.
res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
res.end(JSON.stringify({ error: 'Verzoek te groot.' }));
}
req.destroy();
return finish(null);
}
chunks.push(c);
});
req.on('end', () => {
try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
catch { finish({}); }
});
req.on('error', () => finish(null));
req.on('aborted', () => finish(null));
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
// ---------- Base PWA: manifest + iconen + service worker + Web Push ----------
// Web Push is hier dependency-vrij geimplementeerd (VAPID + RFC 8291
// aes128gcm) met alleen Node's ingebouwde crypto, zodat er geen npm-install
// nodig is en de server nooit kan crashen op een ontbrekende module. De
// VAPID-sleutels worden eenmalig gegenereerd en in Upstash bewaard ('vapid').
const wpB64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const wpB64uToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const PWA_ICONS = {
'/base/icon-192.png': Buffer.from('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', 'base64'),
'/base/icon-512.png': Buffer.from('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', 'base64'),
'/base/apple-touch-icon.png': Buffer.from('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', 'base64'),
};

const PWA_MANIFEST = JSON.stringify({
name: 'VDK Base', short_name: 'Base', id: '/base', start_url: '/base',
scope: '/base', display: 'standalone', background_color: '#11151c', theme_color: '#11151c',
icons: [
{ src: '/base/icon-192.png', sizes: '192x192', type: 'image/png' },
{ src: '/base/icon-512.png', sizes: '512x512', type: 'image/png' },
],
});

const PWA_SW = [
"self.addEventListener('install', () => self.skipWaiting());",
"self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
"self.addEventListener('push', (e) => {",
"let d = {};",
"try { d = e.data ? e.data.json() : {}; } catch (err) {}",
"e.waitUntil(self.registration.showNotification(d.title || 'Base', {",
"body: d.body || '', icon: '/base/icon-192.png', badge: '/base/icon-192.png',",
"tag: d.tag || undefined, data: { url: d.url || '/base' },",
"}));",
"});",
"self.addEventListener('notificationclick', (e) => {",
"e.notification.close();",
"const url = (e.notification.data && e.notification.data.url) || '/base';",
"e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {",
"for (const c of list) {",
"if (c.url.includes('/base') && 'focus' in c) { c.navigate(url); return c.focus(); }",
"}",
"return self.clients.openWindow(url);",
"}));",
"});",
''].join('\n');

async function getVapidKeys() {
let k = null;
try { k = await kvGetJson('vapid'); } catch (e) {}
if (k && k.publicKey && k.privateKey) return k;
const ec = crypto.createECDH('prime256v1');
ec.generateKeys();
let priv = ec.getPrivateKey();
if (priv.length < 32) priv = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
k = { publicKey: wpB64u(ec.getPublicKey()), privateKey: wpB64u(priv) };
await kvSetJson('vapid', k);
return k;
}

function wpVapidJwt(audience, keys) {
const now = Math.floor(Date.now() / 1000);
const unsigned = wpB64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' +
wpB64u(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: 'mailto:' + ADMIN_EMAIL }));
const pub = wpB64uToBuf(keys.publicKey);
const keyObj = crypto.createPrivateKey({
key: { kty: 'EC', crv: 'P-256', x: wpB64u(pub.slice(1, 33)), y: wpB64u(pub.slice(33, 65)), d: keys.privateKey },
format: 'jwk',
});
const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: keyObj, dsaEncoding: 'ieee-p1363' });
return unsigned + '.' + wpB64u(sig);
}

function wpEncrypt(payload, p256dh, auth) {
const uaPub = wpB64uToBuf(p256dh);
const authSecret = wpB64uToBuf(auth);
const ec = crypto.createECDH('prime256v1');
ec.generateKeys();
const asPub = ec.getPublicKey();
const shared = ec.computeSecret(uaPub);
const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPub, asPub]), 32));
const salt = crypto.randomBytes(16);
const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
const enc = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
const header = Buffer.alloc(21);
salt.copy(header, 0);
header.writeUInt32BE(4096, 16);
header.writeUInt8(65, 20);
return Buffer.concat([header, asPub, enc]);
}

async function wpSend(sub, payload) {
const u = new URL(sub.endpoint);
const keys = await getVapidKeys();
const body = wpEncrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
const r = await fetch(sub.endpoint, {
method: 'POST',
headers: {
Authorization: 'vapid t=' + wpVapidJwt(u.origin, keys) + ', k=' + keys.publicKey,
'Content-Encoding': 'aes128gcm',
'Content-Type': 'application/octet-stream',
TTL: '86400',
Urgency: 'high',
},
body,
});
return { status: r.status, gone: r.status === 404 || r.status === 410 };
}

const pushSubsKey = (email) => 'push:' + email;

async function pushToAll(email, payload) {
let subs = null;
try { subs = await kvGetJson(pushSubsKey(email)); } catch (e) {}
subs = subs || [];
if (!subs.length) return { delivered: 0, results: [], note: 'geen apparaten aangemeld' };
const results = [];
const keep = [];
for (const s of subs) {
try {
const r = await wpSend(s, payload);
results.push({ endpoint: s.endpoint.slice(0, 60), status: r.status });
if (!r.gone) keep.push(s);
} catch (e) {
results.push({ endpoint: s.endpoint.slice(0, 60), error: e.message });
keep.push(s);
}
}
if (keep.length !== subs.length) { try { await kvSetJson(pushSubsKey(email), keep); } catch (e) {} }
return { delivered: results.filter((x) => x.status >= 200 && x.status < 300).length, results };
}

// Wordt periodiek aangeroepen via /api/cron/push: stuurt een pushmelding voor
// elke reminder van vandaag met een tijd die zojuist (maximaal 45 min geleden)
// is verstreken. Dubbele meldingen worden voorkomen via een pushsent-sleutel.
async function pushDueReminderCheck() {
const TZ = 'Europe/Amsterdam';
let reminders = null;
try { reminders = await kvGetJson('rem:' + ADMIN_EMAIL); } catch (e) {}
reminders = reminders || [];
const t = zonedTodayYMD(TZ);
const pad2 = (n) => String(n).padStart(2, '0');
const todayISO = t.y + '-' + pad2(t.m) + '-' + pad2(t.d);
const midnightMs = zonedMidnightUTC(t, TZ).getTime();
const now = Date.now();
const fmtHM = (ms) => { const mtot = Math.round((ms - midnightMs) / 60000); return pad2(Math.floor((((mtot % 1440) + 1440) % 1440) / 60)) + ':' + pad2(((mtot % 60) + 60) % 60); };
// Meldingsschema zoals Structured: per item met tijd standaard drie alerts
// (5 min voor start, bij start, bij einde), per item uitzetbaar via r.alerts.
const occursToday = (r) => {
if (r.due === todayISO) return true;
if (!r.repeat || !r.repeat.type || !r.due || todayISO < r.due) return false;
      if (r.repeat.until && todayISO > r.repeat.until) return false;
if (r.repeat.type === 'daily') return true;
const a = new Date(r.due + 'T00:00:00Z');
const d = new Date(todayISO + 'T00:00:00Z');
if (r.repeat.type === 'weekly') return a.getUTCDay() === d.getUTCDay();
if (r.repeat.type === 'monthly') return a.getUTCDate() === d.getUTCDate();
return false;
};
const isDoneToday = (r) => (r.repeat && r.repeat.type) ? (Array.isArray(r.doneDates) && r.doneDates.includes(todayISO)) : r.done;
const due = reminders.filter((r) => !isDoneToday(r) && occursToday(r) && /^\d{2}:\d{2}$/.test(r.time || ''));
let sent = 0;
const results = [];
for (const r of due) {
const hm = r.time.split(':');
const startMs = midnightMs + (Number(hm[0]) * 60 + Number(hm[1])) * 60000;
const endMs = startMs + (r.duration && r.duration > 0 ? r.duration : 60) * 60000;
const al = r.alerts || { pre: true, start: true, end: true };
const endHM = fmtHM(endMs);
const alerts = [];
if (al.pre !== false) alerts.push({ kind: 'pre', at: startMs - 5 * 60000, title: '\u23F0 Over 5 min: ' + r.title, body: 'Start om ' + r.time });
if (al.start !== false) alerts.push({ kind: 'start', at: startMs, title: '\u25B6\uFE0F Nu: ' + r.title, body: r.time + ' tot ' + endHM });
if (al.end !== false && r.duration && r.duration > 0) alerts.push({ kind: 'end', at: endMs, title: '\u2705 Klaar: ' + r.title + '?', body: 'Liep tot ' + endHM + '. Vink af in Base.' });
for (const a of alerts) {
if (now < a.at || now - a.at > 45 * 60000) continue;
const sentKey = 'pushsent:' + r.id + ':' + r.due + ':' + a.kind;
let already = null;
try { already = await kvCmd('GET', sentKey); } catch (e) {}
if (already) continue;
try { await kvCmd('SET', sentKey, '1'); await kvCmd('EXPIRE', sentKey, '259200'); } catch (e) {}
const out = await pushToAll(ADMIN_EMAIL, { title: a.title, body: a.body, url: '/base#tijdlijn?d=' + r.due, tag: 'rem-' + r.id + '-' + a.kind });
sent++;
results.push({ id: r.id, kind: a.kind, delivered: out.delivered });
}
}
return { ok: true, candidates: due.length, sent, results };
}

// Widget-feed (Scriptable): read-only, beveiligd met een eenmalig gegenereerd
// token dat alleen de admin via /api/widget/token kan opvragen.
async function getWidgetToken() {
let tk = null;
try { tk = await kvCmd('GET', 'widgettoken'); } catch (e) {}
if (tk) return tk;
tk = wpB64u(crypto.randomBytes(24));
try { await kvCmd('SET', 'widgettoken', tk); } catch (e) {}
return tk;
}

async function widgetTimelineData() {
const TZ = 'Europe/Amsterdam';
const t = zonedTodayYMD(TZ);
const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (x) => x.y + '-' + pad2(x.m) + '-' + pad2(x.d);
const todayISO = isoOf(t);
const tomorrowISO = isoOf(addDaysToYMD(t, 1));
let reminders = null;
try { reminders = await kvGetJson('rem:' + ADMIN_EMAIL); } catch (e) {}
reminders = reminders || [];
const occursOnW = (r, d) => {
if (r.due === d) return true;
if (!r.repeat || !r.repeat.type || !r.due || d < r.due) return false;
if (r.repeat.type === 'daily') return true;
const a = new Date(r.due + 'T00:00:00Z');
const dd = new Date(d + 'T00:00:00Z');
if (r.repeat.type === 'weekly') return a.getUTCDay() === dd.getUTCDay();
if (r.repeat.type === 'monthly') return a.getUTCDate() === dd.getUTCDate();
return false;
};
const remFor = (d) => reminders
.filter((r) => ((r.repeat && r.repeat.type) ? !(Array.isArray(r.doneDates) && r.doneDates.includes(d)) : !r.done) && occursOnW(r, d))
.map((r) => ({ title: r.title, time: r.time || null, prio: r.prio, icon: r.icon || null, color: r.color || null, duration: r.duration || 0, tl: !!r.tl }))
.sort((a, b) => String(a.time || '99').localeCompare(String(b.time || '99')));
let events = [];
try {
const cred = await kvGetJson(calAppleKey('admin', ADMIN_EMAIL));
if (cred) {
const startStamp = icalUTCStamp(zonedMidnightUTC(t, TZ));
const endStamp = icalUTCStamp(zonedMidnightUTC(addDaysToYMD(t, 2), TZ));
const result = await appleListEvents(cred, startStamp, endStamp);
events = result.events || [];
}
} catch (e) {}
const evFor = (d) => events.filter((ev) => {
if (ev.allDay) {
const s = String(ev.start || '').slice(0, 10);
const e2 = String(ev.end || '').slice(0, 10);
return s <= d && (!e2 || e2 > d);
}
return String(ev.start || '').slice(0, 10) === d;
}).map((ev) => ({ title: ev.title, start: ev.start, end: ev.end || null, allDay: !!ev.allDay }));
return {
generatedAt: new Date().toISOString(),
days: [
{ date: todayISO, reminders: remFor(todayISO), events: evFor(todayISO) },
{ date: tomorrowISO, reminders: remFor(tomorrowISO), events: evFor(tomorrowISO) },
],
};
}

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
const body = await readBody(req, res);
if (!body) return;
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
// M-08: de tekst van de upstream-fout kan hostnamen, paden of accountdetails
// bevatten. Die blijft in de log, de gebruiker krijgt een vaste zin.
console.error('apple connect failed:', (e && (e.stack || e.message)) || String(e));
return json(res, 400, { error: 'Koppelen mislukt. Controleer je gegevens.' });
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
const body = await readBody(req, res);
if (!body) return;
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
if (!allowRate('ip:' + clientIp(req))) return json(res, 429, { error: 'Too many attempts. Try again later.' });
const body = await readBody(req, res);
if (!body) return;
const email = String(body.email || '').trim().toLowerCase();
const generic = { ok: true, message: 'If this email is authorized, a code has been sent.' };
// H-03: ongeldige adressen komen nooit tot aan de SMTP-transactie. Het
// antwoord blijft generiek, zodat dit geen manier wordt om te toetsen welke
// adressen bestaan.
if (!isValidEmail(email)) return json(res, 200, generic);
// M-03: tweede emmer op het adres zelf, tegen bestoken vanaf wisselende IP's.
if (!allowRate('mail:' + realm + ':' + email, 5)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
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
// M-05: een 500 hier verscheen alleen bij adressen die de allowlist haalden,
// dus het verschil tussen 200 en 500 verklapte welke accounts bestaan. De
// fout gaat naar de log, de beller krijgt hetzelfde generieke antwoord.
console.error('SMTP send failed:', (err && (err.stack || err.message)) || String(err));
}
} else {
console.log(`[DEV] No SMTP configured. Login code for ${realm}:${email}: ${code}`);
}
return json(res, 200, generic);
}

async function handleVerify(req, res, realm) {
if (!allowRate('ip:' + clientIp(req))) return json(res, 429, { error: 'Too many attempts. Try again later.' });
const body = await readBody(req, res);
if (!body) return;
const email = String(body.email || '').trim().toLowerCase();
if (!isValidEmail(email)) return json(res, 401, { error: 'Code ongeldig of verlopen. Vraag een nieuwe aan.' });
if (!allowRate('verify:' + realm + ':' + email, 10)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
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
  function assistantMemKey(email) { return 'asstmem:' + email; }

async function buildAssistantContext(email) {
  const [reminders, sugs, ideas, gymGoals, gymLog, gymPrefs, pref, mem] = await Promise.all([
    kvGetJson('rem:' + email).catch(() => null),
    kvGetJson('sug:' + email).catch(() => null),
    kvGetJson('idea:' + email).catch(() => null),
    kvGetJson(gymGoalKey(email)).catch(() => null),
    kvGetJson(gymLogKey(email)).catch(() => null),
    kvGetJson('gympref:' + email).catch(() => null),
    kvGetJson('pref:' + email).catch(() => null),
        kvGetJson(assistantMemKey(email)).catch(() => null),
  ]);
  const now = Date.now();
  const todayISO = new Date(now).toISOString().slice(0, 10);
  const weekAheadISO = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
  const twoWeeksAgoISO = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
  const upcomingReminders = (reminders || [])
.filter((r) => !r.tl)
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
    .map((x) => ({ exercise: x.exercise, date: x.date, weight: x.weight, reps: x.reps, muscle: x.muscle, restSeconds: x.restSeconds || null, time: x.createdAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(x.createdAt)) : null }));
  return {
    today: todayISO,
        memory: mem || '',
    upcomingReminders: upcomingReminders,
    dueSuggestions: dueSuggestions,
    openIdeas: openIdeas,
    gymGoals: openGoals,
    gymRecentSets: recentSets,
    gymPrefs: gymPrefs || {},
    onboarding: {
      hasAccountName: !!(pref && pref.name),
      hasAnyReminders: (reminders || []).filter((r) => !r.tl).length > 0,
      hasGymSetup: (gymGoals || []).length > 0 || (gymLog || []).length > 0,
    },
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
    "PROJECT CONTEXT (for when the user asks what this app/project is, or talks about something they are building or designing): VDK Base is Ruben’s own actively-evolving personal-assistant project, not a finished product — he keeps adding to it. It already includes Reminders, recurring Suggestions, a visual Timeline, an Idea box, Gym coaching (goals, progressive-overload advice, a muscle-coverage session composer), and a separate connected CRM, all in one Node.js app (repo \"vdk-website\") hosted on Render at vdkbusiness-services.nl. The design principles behind every feature: keep all data private in the user own storage, never train any external model on it (Groq was chosen specifically because it does not train on submitted data, unlike some free alternatives), stay mindful of EU privacy rules, never silently execute anything without explicit confirmation, and keep learning which things are actually worth surfacing to this one user. You can discuss this background naturally, but you are not a coding assistant for the project — you are the in-app assistant for the user day-to-day use of it.",
    "PERSONA: calm, short, to the point. Never use enthusiastic filler, exclamation marks, or a bulleted list when one sentence will do. You are allowed a dry, restrained sense of humor — but never at the cost of clarity; you are helpful, not an entertainer. You are not formally submissive (no \"Sir\", no over-apologizing) — you are direct and confident: you state things and act, you don't hedge or doubt out loud. You are proactive within limits: if the data already shows something worth flagging (a goal behind schedule, an idea untouched for weeks), you may mention it unprompted — but you never push, nag, or repeat a nudge the user didn't ask for. This character must come through naturally in BOTH Dutch and English — do not write one fixed sentence and translate it; write each reply directly in the target language, in the same tone.",
    "Calibration examples (match this tone, don't reuse these exact words — write fresh replies for the actual conversation): " +
      "Simple question — Q: \"Wat staat er deze week nog open?\" A: \"Drie dingen: de deadline donderdag, je gym sessie die je nog niet hebt gepland, en het nieuwsbrief-idee dat al vijf weken ligt te wachten.\" (EN equivalent tone: \"Three things: Thursday's deadline, the gym session you haven't scheduled yet, and the newsletter idea that's been sitting for five weeks.\") " +
      "Unprompted but restrained: \"Je gym doel loopt drie dagen achter op schema. Wil je dat ik een sessie inplan, of laat je het lopen?\" " +
      "Dry humor, never at the cost of clarity — Q: \"Ik heb weer drie dagen niet getraind\" A: \"Dat is dan drie dagen op rij dat 'morgen' de dag is. Sessie inplannen, of hou je het bij goede voornemens?\" " +
      "Out of scope, no over-apologizing — Q: \"Verwijder die herinnering\" A: \"Verwijderen kan ik nog niet, dat komt in een latere ronde. Wil je dat ik 'm afvink in plaats van weglaten?\"",
    "You can see ONLY this one user's own data below (reminders, suggestions, ideas, Gym goals/logs) — never claim to know anything else, and never invent data that isn't in this context.",
          (ctx.memory ? ("MEMORY FROM EARLIER CONVERSATIONS (compact summary; use only if the user references something from before, don't dump it unprompted): " + ctx.memory) : ""),
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

async function handleAssistantNewSession(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in.' });
  try {
    const histKey = assistantHistKey(s.email);
    const memKey = assistantMemKey(s.email);
    const history = (await kvGetJson(histKey)) || [];
    if (!history.length) return json(res, 200, { ok: true });
    const apiKey = (process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) { await kvDel(histKey); return json(res, 200, { ok: true }); }
    const oldMemory = (await kvGetJson(memKey)) || '';
    const model = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
    const convoText = history.slice(-40).map((m) => (m.role === 'user' ? 'User: ' : 'Base: ') + String(m.content || '').slice(0, 500)).join('\n');
    const sumPrompt = [
      'Update the running memory summary for this user\'s assistant "Base" (VDK Business Services admin panel).',
      'Existing memory summary (may be empty):',
      oldMemory || '(none yet)',
      '',
      'New conversation to fold in:',
      convoText,
      '',
      'Write an updated compact summary (max ~200 words, plain text, no markdown) capturing durable facts, preferences, decisions and things the user said that might matter later. Drop small talk. Keep it in the same language the user used most.',
    ].join('\n');
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model, messages: [{ role: 'user', content: sumPrompt }], max_tokens: 400, temperature: 0.2 }),
    });
    const d = await r.json().catch(() => ({}));
    const newMemory = ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
    if (newMemory) await kvSetJson(memKey, newMemory);
    await kvDel(histKey);
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('assistant newsession failed:', e);
    try { await kvDel(assistantHistKey(s.email)); } catch (_) {}
    return json(res, 200, { ok: true });
  }
}

async function handleAssistantChat(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return json(res, 503, { error: 'De assistent is nog niet ingesteld (GROQ_API_KEY ontbreekt in Render — gratis te maken op console.groq.com).' });
  try {
    const body = await readBody(req, res);
    if (!body) return;
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

    const model = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
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
      return json(res, 502, { error: 'De assistent kon niet antwoorden. Probeer het zo nog eens.', debugDetail: (d && d.error) ? String(typeof d.error === 'string' ? d.error : JSON.stringify(d.error)).slice(0,500) : ('status ' + r.status + ' model ' + model) });
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

const ASSISTANT_PROACTIVE_CATEGORIES = ['reminder', 'gym', 'idea', 'suggestion', 'onboarding_account', 'onboarding_gym', 'onboarding_reminders', 'other'];

function assistantLearnKey(email) { return 'asstlearn:' + email; }
function assistantSnoozeKey(email) { return 'asstsnooze:' + email; }

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

function assistantTopicKey(category, overdueTop, action) {
  if (category === 'reminder' && overdueTop && overdueTop.id != null) {
    return 'reminder:' + overdueTop.id;
  }
  if (action && action.type) {
    const p = action.params || {};
    const idPart = (p.id != null) ? String(p.id) : (p.title ? String(p.title).slice(0, 60) : '');
    if (idPart) return action.type + ':' + idPart;
  }
  return null;
}

function assistantIsSnoozed(snoozeMap, topicKey) {
  if (!topicKey || !snoozeMap) return false;
  const s = snoozeMap[topicKey];
  if (!s) return false;
  const COOLDOWN_MS = 4 * 60 * 60 * 1000;
  return s.streak >= 3 && (Date.now() - s.lastAt) < COOLDOWN_MS;
}

function assistantDedupeTrailingProactive(history) {
  if (!Array.isArray(history) || history.length < 2) return history;
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant' || !last.proactive) return history;
  let cut = history.length - 1;
  while (cut > 0) {
    const prev = history[cut - 1];
    if (prev && prev.role === 'assistant' && prev.proactive && prev.category === last.category) {
      cut--;
    } else break;
  }
  if (cut === history.length - 1) return history;
  return history.slice(0, cut).concat([last]);
}

async function assistantLearningSummary(email) {
  const counts = (await kvGetJson(assistantLearnKey(email)).catch(() => null)) || {};
  const lines = [];
  let anyLowEngagement = false;
  for (const cat of ASSISTANT_PROACTIVE_CATEGORIES) {
    const c = counts[cat];
    const events = (c && Array.isArray(c.events)) ? c.events : [];
    if (events.length >= 3) {
      const engaged = events.filter((e) => e.engaged).length;
      const pct = Math.round((engaged / events.length) * 100);
      lines.push(cat + ': ' + engaged + '/' + events.length + ' (' + pct + '%)');
      if (pct < 30) anyLowEngagement = true;
    }
  }
  if (!lines.length) return null;
  let summary = lines.join(', ');
  if (anyLowEngagement) {
    summary += '. Even a low-engagement category should still be raised occasionally (roughly 1 in 5 times) if there is nothing more pressing to say, in case priorities have changed.';
  }
  return summary;
}

async function handleAssistantProactive(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return json(res, 200, { ok: true, reply: null });
  try {
    const body = await readBody(req, res);
    if (!body) return;
    const page = String(body.page || '').slice(0, 40);
    const lang = body.lang === 'nl' ? 'nl' : 'en';

    const histKey = assistantHistKey(s.email);
    let history = (await kvGetJson(histKey)) || [];

    let historyChanged = false;
    const deduped = assistantDedupeTrailingProactive(history);
    if (deduped !== history) {
      history = deduped;
      historyChanged = true;
    }

    const context = await buildAssistantContext(s.email);
    const overdueAll = assistantOverdueReminders(context);
    const snoozeMap = (await kvGetJson(assistantSnoozeKey(s.email)).catch(() => null)) || {};
    const overdue = overdueAll.filter((r) => !assistantIsSnoozed(snoozeMap, 'reminder:' + r.id));
    const learningText = await assistantLearningSummary(s.email);

    // Migrate a pre-existing (pre-topicKey) trailing reminder nudge so future boots
    // recognize it as the same topic instead of generating yet another duplicate.
    if (overdue.length > 0 && history.length > 0) {
      const tail = history[history.length - 1];
      if (tail && tail.role === 'assistant' && tail.proactive && tail.category === 'reminder' && !tail.topicKey) {
        tail.topicKey = 'reminder:' + overdue[0].id;
        historyChanged = true;
      }
    }

    if (historyChanged) {
      await kvSetJson(histKey, history);
    }

    if (overdue.length > 0) {
      const topTopicKey = 'reminder:' + overdue[0].id;
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.proactive && lastMsg.category === 'reminder' && lastMsg.topicKey === topTopicKey) {
        return json(res, 200, { ok: true, reply: lastMsg.content, action: lastMsg.action || null, urgent: true, category: 'reminder', topicKey: topTopicKey });
      }
    }

    let systemPrompt = buildAssistantSystemPrompt(page, lang, context) + '\n' +
      'PROACTIVE CHECK: you are not responding to a user message right now. Look only at the context above and decide, independently, whether there is exactly ONE thing worth proactively flagging to the user right now (something overdue, a suggestion that has been waiting, a Gym goal falling behind, an idea untouched for a long time, or - only if nothing more pressing applies - a calm, low-key nudge toward a part of Base the user has not set up yet, see ONBOARDING below). Be selective and restrained - most checks should find nothing worth mentioning. If nothing clears that bar, reply with exactly {"reply": null, "action": null, "category": null}. If something does, phrase it the same short, calm way as your other replies, and only set "action" if you have enough detail to concretely propose one from the allowed set. Also include a "category" field in your JSON reply, chosen from exactly one of: reminder, gym, idea, suggestion, onboarding_account, onboarding_gym, onboarding_reminders, other - matching what your reply is mainly about.';
    if (context.onboarding && (!context.onboarding.hasAccountName || !context.onboarding.hasGymSetup || !context.onboarding.hasAnyReminders)) {
      const missing = [];
      if (!context.onboarding.hasAccountName) missing.push('the user has not set their name yet (category onboarding_account) - you could ask how they would like to be addressed');
      if (!context.onboarding.hasGymSetup) missing.push('the user has never logged a Gym goal or session (category onboarding_gym) - you could ask if they want to set one up');
      if (!context.onboarding.hasAnyReminders) missing.push('the user has no reminders at all yet (category onboarding_reminders) - you could ask if there is something they want a reminder for');
      systemPrompt += '\nONBOARDING (lowest priority - only surface this if nothing more urgent applies, at most once per check, and phrase it as a genuine, low-pressure question, never a checklist or sales pitch): ' + missing.join('; ') + '.';
    }
    if (overdue.length > 0) {
      systemPrompt += '\nURGENT: the user has ' + overdue.length + ' overdue reminder(s) - you MUST mention at least one of them in your reply, this takes priority over anything else you might otherwise flag.';
    }
    if (learningText) {
      systemPrompt += '\nENGAGEMENT HISTORY (how often the user actually engaged with your past proactive check-ins, per category - use this to judge what still seems worth surfacing; a category with low engagement should only be raised again if it is clearly important or urgent): ' + learningText + '.';
    }

    const apiMessages = [{ role: 'system', content: systemPrompt }];

    const model = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
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
        const topicKey = 'reminder:' + overdue[0].id;
        const now2f = Date.now();
        history.push({ role: 'assistant', content: fallback, at: now2f, action: null, proactive: true, category: 'reminder', topicKey: topicKey });
        history = history.slice(-60);
        await kvSetJson(histKey, history);
        bump('asst');
        return json(res, 200, { ok: true, reply: fallback, action: null, urgent: true, category: 'reminder', topicKey: topicKey });
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
    const topicKey = assistantTopicKey(category, overdue[0] || null, action);

    const now2 = Date.now();
    history.push({ role: 'assistant', content: replyText, at: now2, action: action, proactive: true, category: category, topicKey: topicKey });
    history = history.slice(-60);
    await kvSetJson(histKey, history);
    bump('asst');

    return json(res, 200, { ok: true, reply: replyText, action: action, urgent: urgent, category: category, topicKey: topicKey });
  } catch (e) {
    console.error('assistant proactive error:', e.message);
    return json(res, 200, { ok: true, reply: null });
  }
}

async function handleAssistantFeedback(req, res) {
  const s = await getSession(req, 'admin');
  if (!s) return json(res, 401, { error: 'Not logged in' });
  try {
    const body = await readBody(req, res);
    if (!body) return;
    const category = ASSISTANT_PROACTIVE_CATEGORIES.includes(body.category) ? body.category : 'other';
    const engaged = !!body.engaged;
    const strong = !!body.strong;
    const topicKey = (typeof body.topicKey === 'string' && body.topicKey.slice(0, 120)) || null;

    const learnKey = assistantLearnKey(s.email);
    const counts = (await kvGetJson(learnKey).catch(() => null)) || {};
    const c = counts[category] || { events: [] };
    if (!Array.isArray(c.events)) c.events = [];
    const now = Date.now();
    c.events.push({ engaged: engaged, at: now });
    if (strong && !engaged) c.events.push({ engaged: false, at: now });
    c.events = c.events.slice(-20);
    counts[category] = c;
    await kvSetJson(learnKey, counts);

    if (topicKey) {
      const snoozeKeyName = assistantSnoozeKey(s.email);
      const snoozeMap = (await kvGetJson(snoozeKeyName).catch(() => null)) || {};
      if (engaged) {
        delete snoozeMap[topicKey];
      } else {
        const entry = snoozeMap[topicKey] || { streak: 0, lastAt: 0 };
        entry.streak = Math.min(10, entry.streak + (strong ? 2 : 1));
        entry.lastAt = now;
        snoozeMap[topicKey] = entry;
      }
      await kvSetJson(snoozeKeyName, snoozeMap);
    }

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
    const body = await readBody(req, res);
    if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
tl: body.tl === true,
alerts: (body.alerts && typeof body.alerts === 'object') ? { pre: body.alerts.pre !== false, start: body.alerts.start !== false, end: body.alerts.end !== false } : { pre: true, start: true, end: true },
      repeat: (body.repeat && typeof body.repeat === 'object' && ['daily','weekly','monthly'].includes(body.repeat.type)) ? { type: body.repeat.type, until: /^\d{4}-\d{2}-\d{2}$/.test(String(body.repeat.until || '')) ? body.repeat.until : null } : null,
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
if (body.tl !== undefined) r.tl = body.tl === true;
if (body.alerts && typeof body.alerts === 'object') r.alerts = { pre: body.alerts.pre !== false, start: body.alerts.start !== false, end: body.alerts.end !== false };
    if (body.repeat !== undefined) r.repeat = (body.repeat && typeof body.repeat === 'object' && ['daily','weekly','monthly'].includes(body.repeat.type)) ? { type: body.repeat.type, until: /^\d{4}-\d{2}-\d{2}$/.test(String(body.repeat.until || '')) ? body.repeat.until : null } : null;
if (body.done !== undefined) {
if (body.done && !r.done) bump('rd');
r.done = !!body.done;
}
} else if (body.action === 'doneDate') {
const r = list.find((x) => x.id === body.id);
if (!r) throw apiError(404, 'Niet gevonden');
const date = String(body.date || '').slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw apiError(400, 'Ongeldige datum');
r.doneDates = Array.isArray(r.doneDates) ? r.doneDates : [];
if (r.doneDates.includes(date)) { r.doneDates = r.doneDates.filter((x) => x !== date); }
else { r.doneDates.push(date); bump('rd'); }
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
} else if (body.action === 'doneDate') {
    if (!r) throw apiError(404, 'Niet gevonden');
    const date = String(body.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw apiError(400, 'Ongeldige datum');
    r.doneDates = Array.isArray(r.doneDates) ? r.doneDates : [];
    if (!r.doneDates.includes(date)) r.doneDates.push(date);
    r.nextDue = addCycle(r, r.nextDue > todayISO ? r.nextDue : todayISO);
  
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

function gymValidCreatedAt(v) {
const t = Number(v);
return Number.isFinite(t) && t > 1577836800000 && t <= Date.now() + 5 * 60 * 1000 ? t : null;
}
function investTxKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investtx:${email}:${portfolioId}` : `investtx:${email}`; }
function investDivKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investdiv:${email}:${portfolioId}` : `investdiv:${email}`; }
function investOtherKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investother:${email}:${portfolioId}` : `investother:${email}`; }
function investPortfoliosKey(email) { return `investportfolios:${email}`; }
function investPortfolioIdFromReq(req, url, body) {
const raw = (body && body.portfolioId !== undefined) ? body.portfolioId : (url ? url.searchParams.get('portfolioId') : null);
const id = String(raw || 'default').trim().slice(0, 40);
return /^[a-zA-Z0-9_-]+$/.test(id) ? id : 'default';
}
async function investGetPortfolios(email) {
let list = (await kvGetJson(investPortfoliosKey(email))) || [];
if (!Array.isArray(list) || !list.length) {
list = [{ id: 'default', name: 'Portfolio 1', createdAt: Date.now() }];
await kvSetJson(investPortfoliosKey(email), list);
}
return list;
}
async function handleInvestPortfolios(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
if (req.method === 'GET') return json(res, 200, await investGetPortfolios(s.email));
if (req.method === 'POST') {
const body = await readBody(req, res);
if (!body) return;
const key = investPortfoliosKey(s.email);
let list = await investGetPortfolios(s.email);
if (body.action === 'create') {
const name = String(body.name || '').trim().slice(0, 60);
if (!name) throw apiError(400, 'Vul een naam in.');
if (list.length >= 10) throw apiError(400, 'Maximaal 10 portfolios.');
const id = crypto.randomUUID();
list.push({ id, name, createdAt: Date.now() });
await kvSetJson(key, list);
return json(res, 200, { ok: true, portfolios: list, created: id });
} else if (body.action === 'rename') {
const it = list.find((x) => x.id === body.id);
if (!it) throw apiError(404, 'Niet gevonden');
const name = String(body.name || '').trim().slice(0, 60);
if (!name) throw apiError(400, 'Vul een naam in.');
it.name = name;
await kvSetJson(key, list);
return json(res, 200, { ok: true, portfolios: list });
} else if (body.action === 'delete') {
if (list.length <= 1) throw apiError(400, 'Je moet minstens 1 portfolio overhouden.');
const delId = String(body.id || '');
list = list.filter((x) => x.id !== delId);
await kvSetJson(key, list);
await kvSetJson(investTxKey(s.email, delId), []);
await kvSetJson(investDivKey(s.email, delId), []);
await kvSetJson(investSnapKey(s.email, delId), []);
await kvSetJson(investSectorKey(s.email, delId), {});
await kvSetJson(investStrategyKey(s.email, delId), {})
return json(res, 200, { ok: true, portfolios: list });
}
throw apiError(400, 'Onbekende actie');
}
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('invest portfolios API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}
function investValidCreatedAt(v) {
const t = Number(v);
return Number.isFinite(t) && t > 1577836800000 && t <= Date.now() + 5 * 60 * 1000 ? t : null;
}

function investComputeHoldings(transactions) {
const bySymbol = new Map();
const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : 1));
for (const tx of sorted) {
if (!bySymbol.has(tx.symbol)) {
bySymbol.set(tx.symbol, { symbol: tx.symbol, name: tx.name, currency: tx.currency, shares: 0, costBasis: 0, realizedPnl: 0, firstBuyDate: null })
}
const h = bySymbol.get(tx.symbol);
if (tx.type === 'buy') {
h.shares += tx.shares;
h.costBasis += tx.shares * tx.price + (tx.fees || 0);
if (!h.firstBuyDate) h.firstBuyDate = tx.date
} else if (tx.type === 'sell') {
if (h.shares > 0) {
const costPerShare = h.costBasis / h.shares;
const sellShares = Math.min(tx.shares, h.shares);
h.costBasis -= sellShares * costPerShare;
h.shares -= sellShares;
h.realizedPnl += sellShares * (tx.price - costPerShare) - (tx.fees || 0);
} else {
h.realizedPnl -= tx.fees || 0;
}
}
}
return [...bySymbol.values()].map((h) => {
const shares = Math.abs(h.shares) < 1e-6 ? 0 : h.shares;
return { ...h, shares, avgCost: shares > 0 ? h.costBasis / shares : 0, closed: shares <= 0 };
});
}

async function handleInvestTimetravel(req, res) {
const s = await getSession(req, 'admin')
if (!s) return json(res, 401, { error: 'Not logged in' })
try {
const __url = new URL(req.url, 'http://localhost')
const portfolioId = investPortfolioIdFromReq(req, __url, null)
const dateParam = __url.searchParams.get('date')
const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateParam || '')) ? dateParam : new Date().toISOString().slice(0, 10)
const allTransactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || []
const transactions = allTransactions.filter((tx) => tx.date <= date)
const holdings = investComputeHoldings(transactions).filter((h) => !h.closed)
const sectorMap = (await kvGetJson(investSectorKey(s.email, portfolioId))) || {}
const byCountryMap = new Map()
const bySectorMap = new Map()
let totalValueEUR = 0
const enriched = []
for (const h of holdings) {
const histPrice = await investGetHistoricalPrice(h.symbol, date)
const fx = await investGetFxRate(h.currency, 'EUR')
const valueEUR = histPrice !== null ? histPrice * h.shares * fx : null
if (valueEUR !== null) totalValueEUR += valueEUR
const country = (await investGetInstrumentCountry(h.symbol)) || 'Onbekend'
byCountryMap.set(country, (byCountryMap.get(country) || 0) + (valueEUR || 0))
const sector = sectorMap[h.symbol] || 'Onbekend'
bySectorMap.set(sector, (bySectorMap.get(sector) || 0) + (valueEUR || 0))
enriched.push({ symbol: h.symbol, name: h.name, shares: h.shares, historicalPrice: histPrice, valueEUR, currency: h.currency, firstBuyDate: h.firstBuyDate })
}
const toList = (map) => [...map.entries()].map(([key, valueEUR]) => ({ key, valueEUR, pct: totalValueEUR > 0 ? valueEUR / totalValueEUR : 0 })).sort((a, b) => b.valueEUR - a.valueEUR)
return json(res, 200, { date, holdings: enriched, totalValueEUR, byCountry: toList(byCountryMap), bySector: toList(bySectorMap) })
} catch (e) {
console.error('invest timetravel API error:', e.message)
return json(res, 500, { error: 'Kon tijdreis niet berekenen.' })
}
}
async function handleInvestPositionDetail(req, res) {
const s = await getSession(req, 'admin')
if (!s) return json(res, 401, { error: 'Not logged in' })
try {
const __url = new URL(req.url, 'http://localhost')
const portfolioId = investPortfolioIdFromReq(req, __url, null)
const symbol = String(__url.searchParams.get('symbol') || '').trim()
if (!symbol) return json(res, 400, { error: 'Symbool ontbreekt' })
const allTransactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || []
const transactions = allTransactions.filter((tx) => tx.symbol === symbol).sort((a, b) => (a.date < b.date ? -1 : 1))
if (!transactions.length) return json(res, 404, { error: 'Geen transacties voor dit symbool' })
const allDividends = (await kvGetJson(investDivKey(s.email, portfolioId))) || []
const dividends = allDividends.filter((d) => d.symbol === symbol)
const holdings = investComputeHoldings(allTransactions)
const h = holdings.find((x) => x.symbol === symbol) || { shares: 0, costBasis: 0, realizedPnl: 0, avgCost: null, closed: true }
const last = transactions[transactions.length - 1]
const currency = last.currency || 'EUR'
const fx = await investGetFxRate(currency, 'EUR')
const quote = h.shares > 0 ? await investGetQuote(symbol) : null
const price = quote ? quote.price : null

const txDetail = []
for (const tx of transactions) {
const txFx = await investGetFxRate(tx.currency, 'EUR')
const feesEUR = (tx.fees || 0) * txFx
txDetail.push({
id: tx.id, type: tx.type, date: tx.date, shares: tx.shares, price: tx.price,
currency: tx.currency, fees: tx.fees || 0, feesEUR, fxRate: txFx,
valueNative: tx.shares * tx.price, valueEUR: tx.shares * tx.price * txFx,
broker: tx.broker || null, note: tx.note || '',
})
}
const feesTotalEUR = txDetail.reduce((sum, t) => sum + t.feesEUR, 0)

const valueNative = price !== null ? price * h.shares : null
const valueEUR = valueNative !== null ? valueNative * fx : null
const investedEUR = (h.costBasis || 0) * fx
const unrealizedEUR = valueEUR !== null ? valueEUR - investedEUR : null
const realizedEUR = (h.realizedPnl || 0) * fx

const history = await investGetDividendHistory(symbol)
const est = h.shares > 0 ? investEstimateNextDividend(history) : null
const calendarEvents = []
if (est) calendarEvents.push({ type: 'dividend-estimate', date: est.estimatedDate, amountPerShare: est.amountPerShare, currency })
for (const d of dividends) calendarEvents.push({ type: 'dividend-received', date: d.date, amountPerShare: d.amountPerShare, currency: d.currency || currency })
calendarEvents.sort((a, b) => (a.date < b.date ? -1 : 1))

return json(res, 200, {
symbol, name: last.name || symbol, currency, shares: h.shares, avgCost: h.avgCost || null,
currentPrice: price, valueEUR, investedEUR, unrealizedEUR, realizedEUR, feesTotalEUR,
transactions: txDetail, calendarEvents,
})
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message })
console.error('invest position-detail API error:', e.message)
return json(res, 500, { error: 'Kon positiedetail niet laden.' })
}
}


function investEstimateNextDividend(history) {
if (!history || history.length < 2) return null;
const dates = history.map((h) => new Date(h.exDate).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
if (dates.length < 2) return null;
const gaps = [];
for (let i = 1; i < dates.length; i++) gaps.push(dates[i] - dates[i - 1]);
const avgGapMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
const lastDate = dates[dates.length - 1];
const lastAmount = history[history.length - 1].amount;
return { estimatedDate: new Date(lastDate + avgGapMs).toISOString().slice(0, 10), amountPerShare: lastAmount, confidence: 'estimate' };
}

function investLast12mDividendPerShare(dividends, symbol) {
const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
return dividends.filter((d) => d.symbol === symbol && new Date(d.payDate).getTime() >= oneYearAgo).reduce((sum, d) => sum + d.amountPerShare, 0);
}
function investYieldOnCost(holding, dividends) {
if (!holding.avgCost || holding.shares <= 0) return 0;
return investLast12mDividendPerShare(dividends, holding.symbol) / holding.avgCost;
}
function investDividendCagrForSymbol(dividends, symbol) {
const byYear = new Map();
for (const d of dividends) {
if (d.symbol !== symbol) continue;
const year = String(d.payDate).slice(0, 4);
byYear.set(year, (byYear.get(year) || 0) + d.amountPerShare);
}
const currentYear = String(new Date().getFullYear());
const completed = [...byYear.entries()].filter(([y]) => y !== currentYear).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
const cagr = (years) => {
const n = completed.length;
if (n < years + 1) return null;
const start = completed[n - 1 - years];
const end = completed[n - 1];
if (!start || start <= 0) return null;
return Math.pow(end / start, 1 / years) - 1;
};
return { cagr1y: cagr(1), cagr3y: cagr(3), cagr5y: cagr(5), cagr10y: cagr(10) };
}

async function tdFetch(path, params) {
const apiKey = process.env.TWELVE_DATA_API_KEY;
if (!apiKey) return { error: 'TWELVE_DATA_API_KEY niet gezet' };
const qs = new URLSearchParams({ ...params, apikey: apiKey }).toString();
try {
const res = await fetch(`https://api.twelvedata.com${path}?${qs}`);
if (!res.ok) return { error: `Twelve Data ${res.status}` };
return await res.json();
} catch (e) {
return { error: String((e && e.message) || e) };
}
}

async function investCached(cacheKey, ttlMs, fetchFn) {
const cache = (await kvGetJson(cacheKey)) || {};
const now = Date.now();
const effectiveTtl = cache.data === null ? Math.min(ttlMs, 60 * 1000) : ttlMs;
if (cache.fetchedAt && now - cache.fetchedAt < effectiveTtl) return cache.data;
const data = await fetchFn();
await kvSetJson(cacheKey, { data, fetchedAt: now });
return data;
}

async function investFetchYahoo(symbol, suf, timeoutMs) {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol + suf), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
if (!res.ok) return null;
const data = await res.json();
const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
return { price: meta.regularMarketPrice, currency: meta.currency || null };
} catch (e) {
return null;
} finally {
clearTimeout(timer);
}
}
async function investGetYahooQuote(symbol, expectedCurrency) {
const suffixes = ['', '.AS', '.DE', '.PA', '.MI', '.L', '.SW', '.LS'];
const settled = await Promise.allSettled(suffixes.map((suf) => investFetchYahoo(symbol, suf, 4000)));
for (let i = 0; i < settled.length; i++) {
const r = settled[i].status === 'fulfilled' ? settled[i].value : null;
if (!r) continue;
if (expectedCurrency && r.currency && r.currency !== expectedCurrency) continue;
return r.price;
}
return null;
}
async function investGetQuote(symbol, currency) {
return investCached(`investquote:${symbol}`, 15 * 60 * 1000, async () => {
const r = await tdFetch('/price', { symbol });
if (!r.error && r.price !== undefined) return { price: parseFloat(r.price) };
const yahooPrice = await investGetYahooQuote(symbol, currency);
if (yahooPrice !== null) return { price: yahooPrice };
return null;
});
}

async function investGetDividendHistory(symbol) {
return investCached(`investdivhist:${symbol}`, 12 * 60 * 60 * 1000, async () => {
const r = await tdFetch('/dividends', { symbol });
if (r.error || !r.dividends) return [];
return r.dividends.map((d) => ({ exDate: d.ex_date, amount: parseFloat(d.amount) }));
});
}

async function investGetFxRate(from, to) {
if (from === to) return 1;
return investCached(`investfx:${from}${to}`, 60 * 60 * 1000, async () => {
const r = await tdFetch('/exchange_rate', { symbol: `${from}/${to}` });
if (r.error || r.rate === undefined) return 1;
return parseFloat(r.rate);
});
}

async function applyInvestTxAction(email, portfolioId, body) {
const key = investTxKey(email, portfolioId);
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const symbol = String(body.symbol || '').trim().slice(0, 30);
if (!symbol) throw apiError(400, 'Vul een ticker in.');
const type = body.type === 'sell' ? 'sell' : 'buy';
const shares = Number(body.shares);
const price = Number(body.price);
if (!shares || shares <= 0) throw apiError(400, 'Vul een geldig aantal aandelen in.');
if (!price || price <= 0) throw apiError(400, 'Vul een geldige prijs in.');
const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : new Date().toISOString().slice(0, 10);
list.push({
id: crypto.randomUUID(),
type, symbol,
name: String(body.name || symbol).trim().slice(0, 100),
currency: /^[A-Z]{3}$/.test(String(body.currency || '')) ? body.currency : 'EUR',
shares, price,
fees: Math.max(0, Number(body.fees) || 0),
date,
note: String(body.note || '').trim().slice(0, 500),
broker: String(body.broker || '').trim().slice(0, 40),
createdAt: investValidCreatedAt(body.createdAt) || Date.now(),
});
} else if (body.action === 'update') {
const it = list.find((x) => x.id === body.id);
if (!it) throw apiError(404, 'Niet gevonden');
if (body.type !== undefined) it.type = body.type === 'sell' ? 'sell' : 'buy';
if (body.symbol !== undefined) it.symbol = String(body.symbol).trim().slice(0, 30) || it.symbol;
if (body.name !== undefined) it.name = String(body.name).trim().slice(0, 100) || it.name;
if (body.currency !== undefined) it.currency = /^[A-Z]{3}$/.test(String(body.currency)) ? body.currency : it.currency;
if (body.shares !== undefined) it.shares = Number(body.shares) || it.shares;
if (body.price !== undefined) it.price = Number(body.price) || it.price;
if (body.fees !== undefined) it.fees = Math.max(0, Number(body.fees) || 0);
if (body.date !== undefined) it.date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : it.date;
if (body.note !== undefined) it.note = String(body.note).trim().slice(0, 500);
if (body.broker !== undefined) it.broker = String(body.broker).trim().slice(0, 40)
if (body.createdAt !== undefined) { const ca = investValidCreatedAt(body.createdAt); if (ca) it.createdAt = ca; }
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
throw apiError(400, 'Onbekende actie');
}
await kvSetJson(key, list);
return list;
}

async function applyInvestDivAction(email, portfolioId, body) {
const key = investDivKey(email, portfolioId);
let list = (await kvGetJson(key)) || [];
if (body.action === 'create') {
const symbol = String(body.symbol || '').trim().slice(0, 30);
if (!symbol) throw apiError(400, 'Vul een ticker in.');
const amountPerShare = Number(body.amountPerShare);
const shares = Number(body.shares);
if (!amountPerShare || amountPerShare <= 0) throw apiError(400, 'Vul een geldig dividend per aandeel in.');
if (!shares || shares <= 0) throw apiError(400, 'Vul een geldig aantal aandelen in.');
const payDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.payDate || '')) ? String(body.payDate) : new Date().toISOString().slice(0, 10);
list.push({
id: crypto.randomUUID(),
symbol,
amountPerShare, shares,
totalAmount: Number(body.totalAmount) || amountPerShare * shares,
currency: /^[A-Z]{3}$/.test(String(body.currency || '')) ? body.currency : 'EUR',
payDate,
exDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.exDate || '')) ? String(body.exDate) : null,
source: 'manual',
note: String(body.note || '').trim().slice(0, 500),
createdAt: investValidCreatedAt(body.createdAt) || Date.now(),
});
} else if (body.action === 'update') {
const it = list.find((x) => x.id === body.id);
if (!it) throw apiError(404, 'Niet gevonden');
if (body.symbol !== undefined) it.symbol = String(body.symbol).trim().slice(0, 30) || it.symbol;
if (body.amountPerShare !== undefined) it.amountPerShare = Number(body.amountPerShare) || it.amountPerShare;
if (body.shares !== undefined) it.shares = Number(body.shares) || it.shares;
if (body.totalAmount !== undefined) it.totalAmount = Number(body.totalAmount) || it.totalAmount;
if (body.currency !== undefined) it.currency = /^[A-Z]{3}$/.test(String(body.currency)) ? body.currency : it.currency;
if (body.payDate !== undefined) it.payDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.payDate)) ? String(body.payDate) : it.payDate;
if (body.exDate !== undefined) it.exDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.exDate)) ? String(body.exDate) : it.exDate;
if (body.note !== undefined) it.note = String(body.note).trim().slice(0, 500);
if (body.createdAt !== undefined) { const ca = investValidCreatedAt(body.createdAt); if (ca) it.createdAt = ca; }
} else if (body.action === 'delete') {
list = list.filter((x) => x.id !== body.id);
} else {
throw apiError(400, 'Onbekende actie');
}
await kvSetJson(key, list);
return list;
}


const INVEST_OTHER_TYPES = ['deposit', 'withdrawal', 'broker-fee', 'interest', 'corporate-action', 'securities-lending', 'isin-change']

async function applyInvestOtherAction(email, portfolioId, body) {
  const key = investOtherKey(email, portfolioId)
  let list = (await kvGetJson(key)) || []
  if (body.action === 'create') {
    const type = INVEST_OTHER_TYPES.includes(body.type) ? body.type : null
    if (!type) throw apiError(400, 'Onbekend actietype.')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : new Date().toISOString().slice(0, 10)
    list.push({
      id: crypto.randomUUID(),
      type,
      symbol: String(body.symbol || '').trim().slice(0, 30),
      amount: Number(body.amount) || 0,
      currency: /^[A-Z]{3}$/.test(String(body.currency || '')) ? body.currency : 'EUR',
      date,
      note: String(body.note || '').trim().slice(0, 500),
      broker: String(body.broker || '').trim().slice(0, 40),
      createdAt: investValidCreatedAt(body.createdAt) || Date.now(),
    })
  } else if (body.action === 'update') {
    const it = list.find((x) => x.id === body.id)
    if (!it) throw apiError(404, 'Niet gevonden')
    if (body.type !== undefined && INVEST_OTHER_TYPES.includes(body.type)) it.type = body.type
    if (body.symbol !== undefined) it.symbol = String(body.symbol).trim().slice(0, 30)
    if (body.amount !== undefined) it.amount = Number(body.amount) || it.amount
    if (body.currency !== undefined) it.currency = /^[A-Z]{3}$/.test(String(body.currency)) ? body.currency : it.currency
    if (body.date !== undefined) it.date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : it.date
    if (body.note !== undefined) it.note = String(body.note).trim().slice(0, 500)
    if (body.broker !== undefined) it.broker = String(body.broker).trim().slice(0, 40)
  } else if (body.action === 'delete') {
    list = list.filter((x) => x.id !== body.id)
  } else {
    throw apiError(400, 'Onbekende actie')
  }
  await kvSetJson(key, list)
  return list
}

async function handleInvestOther(req, res) {
  const s = await getSession(req, 'admin')
  if (!s) return json(res, 401, { error: 'Not logged in' })
  try {
    const __url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET') return json(res, 200, (await kvGetJson(investOtherKey(s.email, investPortfolioIdFromReq(req, __url, null)))) || [])
    if (req.method === 'POST') {
      const body = await readBody(req, res)
      if (!body) return
      const list = await applyInvestOtherAction(s.email, investPortfolioIdFromReq(req, __url, body), body)
      return json(res, 200, { ok: true, items: list })
    }
  } catch (e) {
    if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message })
    console.error('invest other API error:', e.message)
    return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' })
  }
}

async function handleInvestActionLog(req, res) {
  const s = await getSession(req, 'admin')
  if (!s) return json(res, 401, { error: 'Not logged in' })
  try {
    const __url = new URL(req.url, 'http://localhost')
    const portfolioId = investPortfolioIdFromReq(req, __url, null)
    const [txs, divs, others] = await Promise.all([
      kvGetJson(investTxKey(s.email, portfolioId)),
      kvGetJson(investDivKey(s.email, portfolioId)),
      kvGetJson(investOtherKey(s.email, portfolioId)),
    ])
    const items = []
    for (const tx of (txs || [])) {
      items.push({
        id: tx.id, category: tx.type, date: tx.date, symbol: tx.symbol, name: tx.name,
        amount: tx.shares * tx.price, currency: tx.currency, shares: tx.shares, price: tx.price,
        fees: tx.fees || 0, broker: tx.broker || '', note: tx.note || '',
      })
    }
    for (const d of (divs || [])) {
      items.push({
        id: d.id, category: 'dividend', date: d.payDate, symbol: d.symbol, name: d.symbol,
        amount: d.totalAmount, currency: d.currency, shares: d.shares, price: d.amountPerShare,
        fees: 0, broker: '', note: d.note || '',
      })
    }
    for (const o of (others || [])) {
      items.push({
        id: o.id, category: o.type, date: o.date, symbol: o.symbol || '', name: o.symbol || '',
        amount: o.amount, currency: o.currency, shares: null, price: null,
        fees: 0, broker: o.broker || '', note: o.note || '',
      })
    }
    const typeFilter = String(__url.searchParams.get('type') || '').trim()
    const dateFrom = String(__url.searchParams.get('dateFrom') || '').trim()
    const dateTo = String(__url.searchParams.get('dateTo') || '').trim()
    const q = String(__url.searchParams.get('q') || '').trim().toLowerCase()
    let filtered = items
    if (typeFilter) filtered = filtered.filter((it) => it.category === typeFilter)
    if (dateFrom) filtered = filtered.filter((it) => it.date >= dateFrom)
    if (dateTo) filtered = filtered.filter((it) => it.date <= dateTo)
    if (q) filtered = filtered.filter((it) => (it.symbol || '').toLowerCase().includes(q) || (it.name || '').toLowerCase().includes(q) || (it.note || '').toLowerCase().includes(q) || (it.broker || '').toLowerCase().includes(q))
    filtered.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    const categories = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal', 'broker-fee', 'interest', 'corporate-action', 'securities-lending', 'isin-change']
    return json(res, 200, { items: filtered, categories, total: items.length })
  } catch (e) {
    console.error('invest action-log API error:', e.message)
    return json(res, 500, { error: 'Kon logboek niet laden.' })
  }
}
async function handleInvestTx(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const __url = new URL(req.url, 'http://localhost');
if (req.method === 'GET') return json(res, 200, (await kvGetJson(investTxKey(s.email, investPortfolioIdFromReq(req, __url, null)))) || []);
if (req.method === 'POST') {
const body = await readBody(req, res);
if (!body) return;
const list = await applyInvestTxAction(s.email, investPortfolioIdFromReq(req, __url, body), body);
return json(res, 200, { ok: true, transactions: list });
}
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('invest tx API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

async function handleInvestDiv(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const __url = new URL(req.url, 'http://localhost');
if (req.method === 'GET') return json(res, 200, (await kvGetJson(investDivKey(s.email, investPortfolioIdFromReq(req, __url, null)))) || []);
if (req.method === 'POST') {
const body = await readBody(req, res);
if (!body) return;
const list = await applyInvestDivAction(s.email, investPortfolioIdFromReq(req, __url, body), body);
return json(res, 200, { ok: true, dividends: list });
}
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('invest div API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

async function investGetFxRateOnDate(from, to, date) {
if (from === to) return 1;
return investCached(`investfxdate:${from}${to}:${date}`, 30 * 24 * 60 * 60 * 1000, async () => {
const r = await tdFetch('/time_series', { symbol: `${from}/${to}`, interval: '1day', start_date: date, end_date: date, outputsize: 1 });
const vals = r && r.values;
if (r.error || !vals || !vals.length) return null;
return parseFloat(vals[0].close);
});
}

async function investComputeHoldingsEurBasis(transactions) {
const bySymbol = new Map();
const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : 1));
const dateKeys = Array.from(new Set(sorted.filter((tx) => tx.currency !== 'EUR').map((tx) => tx.currency + '|' + tx.date)));
const dateFxEntries = await Promise.all(dateKeys.map(async (key) => {
const [cur, date] = key.split('|');
const fx = await investGetFxRateOnDate(cur, 'EUR', date);
return [key, fx];
}));
const dateFxMap = Object.fromEntries(dateFxEntries);
const fallbackCurrencies = Array.from(new Set(dateKeys.filter((key) => dateFxMap[key] === null).map((key) => key.split('|')[0])));
const fallbackEntries = await Promise.all(fallbackCurrencies.map(async (cur) => [cur, await investGetFxRate(cur, 'EUR')]));
const fallbackFxMap = Object.fromEntries(fallbackEntries);
for (const tx of sorted) {
if (!bySymbol.has(tx.symbol)) bySymbol.set(tx.symbol, { symbol: tx.symbol, shares: 0, costBasisEUR: 0 });
const h = bySymbol.get(tx.symbol);
let fx = 1;
if (tx.currency !== 'EUR') {
const key = tx.currency + '|' + tx.date;
fx = dateFxMap[key];
if (fx === null || fx === undefined) fx = fallbackFxMap[tx.currency];
}
if (tx.type === 'buy') {
h.shares += tx.shares;
h.costBasisEUR += (tx.shares * tx.price + (tx.fees || 0)) * fx;
} else if (tx.type === 'sell') {
if (h.shares > 0) {
const costPerShareEUR = h.costBasisEUR / h.shares;
const sellShares = Math.min(tx.shares, h.shares);
h.costBasisEUR -= sellShares * costPerShareEUR;
h.shares -= sellShares;
}
}
}
return bySymbol;
}

function investXirr(cashflows) {
  if (!cashflows.length) return null
  const t0 = new Date(cashflows[0].date).getTime()
  const years = cashflows.map((cf) => (new Date(cf.date).getTime() - t0) / (365.25 * 24 * 3600 * 1000))
  const npv = (rate) => cashflows.reduce((sum, cf, i) => sum + cf.amount / Math.pow(1 + rate, years[i]), 0)
  const dNpv = (rate) => cashflows.reduce((sum, cf, i) => sum - years[i] * cf.amount / Math.pow(1 + rate, years[i] + 1), 0)
  let rate = 0.1
  for (let i = 0; i < 100; i++) {
    const f = npv(rate)
    const df = dNpv(rate)
    if (Math.abs(df) < 1e-10) break
    let newRate = rate - f / df
    if (!Number.isFinite(newRate)) break
    if (newRate <= -0.99) newRate = -0.99
    if (Math.abs(newRate - rate) < 1e-7) { rate = newRate; break }
    rate = newRate
  }
  return Number.isFinite(rate) ? rate : null
}

async function investBuildCashflowsEUR(transactions, dividends, currentValueEUR) {
  const flows = []
  for (const tx of transactions) {
    let fx = await investGetFxRateOnDate(tx.currency, 'EUR', tx.date)
    if (fx === null) fx = await investGetFxRate(tx.currency, 'EUR')
    const gross = tx.shares * tx.price * fx
    const fees = (tx.fees || 0) * fx
    if (tx.type === 'buy') flows.push({ date: tx.date, amount: -(gross + fees) })
    else flows.push({ date: tx.date, amount: gross - fees })
  }
  for (const d of dividends) {
    let fx = await investGetFxRateOnDate(d.currency, 'EUR', d.payDate)
    if (fx === null) fx = await investGetFxRate(d.currency, 'EUR')
    flows.push({ date: d.payDate, amount: (d.totalAmount || 0) * fx })
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : 1))
  flows.push({ date: new Date().toISOString().slice(0, 10), amount: currentValueEUR })
  return flows
}

async function handleInvestMwrr(req, res) {
  const s = await getSession(req, 'admin')
  if (!s) return json(res, 401, { error: 'Not logged in' })
  try {
    const __url = new URL(req.url, 'http://localhost')
    const portfolioId = investPortfolioIdFromReq(req, __url, null)
    const transactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || []
    const dividends = (await kvGetJson(investDivKey(s.email, portfolioId))) || []
    if (!transactions.length) return json(res, 200, { mwrr: null })
    const holdings = investComputeHoldings(transactions).filter((h) => !h.closed)
    let currentValueEUR = 0
    for (const h of holdings) {
      const quote = await investGetQuote(h.symbol, h.currency)
      const fx = await investGetFxRate(h.currency, 'EUR')
      if (quote) currentValueEUR += quote.price * h.shares * fx
    }
    const flows = await investBuildCashflowsEUR(transactions, dividends, currentValueEUR)
    const hasOutflow = flows.some((f) => f.amount < 0)
    if (!hasOutflow) return json(res, 200, { mwrr: null })
    const rate = investXirr(flows)
    return json(res, 200, { mwrr: rate })
  } catch (e) {
    console.error('invest mwrr API error:', e.message)
    return json(res, 500, { error: 'Kon MWRR niet berekenen.' })
  }
}

function investSettingsKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investsettings:${email}:${portfolioId}` : `investsettings:${email}`; }

async function handleInvestSettings(req, res) {
  const s = await getSession(req, 'admin')
  if (!s) return json(res, 401, { error: 'Not logged in' })
  try {
    const __url = new URL(req.url, 'http://localhost')
    const portfolioId = investPortfolioIdFromReq(req, __url, null)
    const key = investSettingsKey(s.email, portfolioId)
    if (req.method === 'GET') {
      const saved = (await kvGetJson(key)) || {}
      const settings = {
        returnMethod: saved.returnMethod === 'mwrr' ? 'mwrr' : 'absolute',
        emailFrequencies: Object.assign({ weekly: false, monthly: false, quarterly: false, yearly: false }, saved.emailFrequencies || {}),
      }
      return json(res, 200, settings)
    }
    if (req.method === 'POST') {
      const body = await readBody(req, res)
      if (!body) return
      const saved = (await kvGetJson(key)) || {}
      const settings = {
        returnMethod: saved.returnMethod === 'mwrr' ? 'mwrr' : 'absolute',
        emailFrequencies: Object.assign({ weekly: false, monthly: false, quarterly: false, yearly: false }, saved.emailFrequencies || {}),
      }
      if (body.returnMethod !== undefined) settings.returnMethod = body.returnMethod === 'mwrr' ? 'mwrr' : 'absolute'
      if (body.emailFrequencies !== undefined && typeof body.emailFrequencies === 'object') {
        for (const k of ['weekly', 'monthly', 'quarterly', 'yearly']) {
          if (body.emailFrequencies[k] !== undefined) settings.emailFrequencies[k] = !!body.emailFrequencies[k]
        }
      }
      await kvSetJson(key, settings)
      return json(res, 200, settings)
    }
  } catch (e) {
    console.error('invest settings API error:', e.message)
    return json(res, 500, { error: 'Kon instellingen niet opslaan.' })
  }
}


function investEmailFreqDue(freq, date) {
  const day = date.getUTCDay()
  const dom = date.getUTCDate()
  const month = date.getUTCMonth()
  if (freq === 'weekly') return day === 1
  if (freq === 'monthly') return dom === 1
  if (freq === 'quarterly') return dom === 1 && (month === 0 || month === 3 || month === 6 || month === 9)
  if (freq === 'yearly') return dom === 1 && month === 0
  return false
}

async function investBuildEmailSummary(email, portfolioId, portfolioName) {
  const transactions = (await kvGetJson(investTxKey(email, portfolioId))) || []
  const dividends = (await kvGetJson(investDivKey(email, portfolioId))) || []
  const holdings = investComputeHoldings(transactions).filter((h) => !h.closed)
  const eurBasis = await investComputeHoldingsEurBasis(transactions)
  let valueEUR = 0
  let investedEUR = 0
  for (const h of holdings) {
    const quote = await investGetQuote(h.symbol, h.currency)
    const fx = await investGetFxRate(h.currency, 'EUR')
    const price = quote ? quote.price : null
    if (price !== null) valueEUR += price * h.shares * fx
    const basis = eurBasis.get(h.symbol)
    if (basis) investedEUR += basis.costBasisEUR
  }
  const unrealizedEUR = valueEUR - investedEUR
  const now = new Date()
  const ytdStart = now.getUTCFullYear() + '-01-01'
  let dividendYtdEUR = 0
  for (const d of dividends) {
    if (!d.payDate || d.payDate < ytdStart) continue
    let fx = await investGetFxRateOnDate(d.currency, 'EUR', d.payDate)
    if (fx === null) fx = await investGetFxRate(d.currency, 'EUR')
    dividendYtdEUR += (d.totalAmount || 0) * fx
  }
  const pct = investedEUR > 0 ? ((unrealizedEUR / investedEUR) * 100).toFixed(1) : '0.0'
  const lines = []
  lines.push('Portfolio-update: ' + portfolioName)
  lines.push('Waarde: ' + '\u20ac' + valueEUR.toFixed(2))
  lines.push('Ingelegd: ' + '\u20ac' + investedEUR.toFixed(2))
  lines.push('Ongerealiseerd: ' + '\u20ac' + unrealizedEUR.toFixed(2) + ' (' + pct + '%)')
  lines.push('Dividend dit jaar: ' + '\u20ac' + dividendYtdEUR.toFixed(2))
  lines.push('Aantal posities: ' + holdings.length)
  return lines.join('\n')
}

async function investRunEmailDigests() {
  const now = new Date()
  const portfolios = await investGetPortfolios(ADMIN_EMAIL)
  const results = []
  for (const pf of portfolios) {
    const settings = (await kvGetJson(investSettingsKey(ADMIN_EMAIL, pf.id))) || {}
    const freqs = settings.emailFrequencies || {}
    const due = ['weekly', 'monthly', 'quarterly', 'yearly'].filter((f) => freqs[f] && investEmailFreqDue(f, now))
    if (!due.length) continue
    try {
      const summary = await investBuildEmailSummary(ADMIN_EMAIL, pf.id, pf.name || pf.id)
      await sendMail({ to: ADMIN_EMAIL, subject: 'Portfolio-update: ' + (pf.name || pf.id), text: summary })
      results.push({ portfolioId: pf.id, sent: true, frequencies: due })
    } catch (e) {
      results.push({ portfolioId: pf.id, sent: false, error: e.message })
    }
  }
  return results
}
async function handleInvestHoldings(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const portfolioId = investPortfolioIdFromReq(req, new URL(req.url, 'http://localhost'), null);
const transactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || [];
const dividends = (await kvGetJson(investDivKey(s.email, portfolioId))) || [];
const others = (await kvGetJson(investOtherKey(s.email, portfolioId))) || [];
const holdings = investComputeHoldings(transactions).filter((h) => !h.closed);
const eurBasis = await investComputeHoldingsEurBasis(transactions);
let valueEUR = 0, investedEUR = 0, investedEURHistorical = 0, dividendYtdEUR = 0, dividendAllTimeEUR = 0, padiEUR = 0;
const uniqueCurrencies = Array.from(new Set([...holdings.map((h) => h.currency), ...dividends.map((d) => d.currency), 'EUR']));
const fxEntries = await Promise.all(uniqueCurrencies.map(async (cur) => [cur, await investGetFxRate(cur, 'EUR')]));
const fxMap = Object.fromEntries(fxEntries);
const enriched = [];
const holdingResults = await Promise.all(holdings.map(async (h) => {
const quote = await investGetQuote(h.symbol, h.currency);
const fx = fxMap[h.currency] != null ? fxMap[h.currency] : await investGetFxRate(h.currency, 'EUR');
const price = quote ? quote.price : null;
const valueNative = price !== null ? price * h.shares : null;
const valueInEur = valueNative !== null ? valueNative * fx : null;
const investedInEur = h.costBasis * fx;
const investedInEurHist = (eurBasis.get(h.symbol) || {}).costBasisEUR || investedInEur;
const priceReturnEUR = valueInEur !== null ? valueInEur - investedInEur : null;
const currencyEffectEUR = investedInEur - investedInEurHist;
const last12mPerShare = investLast12mDividendPerShare(dividends, h.symbol);
const hPadiEUR = last12mPerShare * h.shares * fx;
const cagrH = investDividendCagrForSymbol(dividends, h.symbol);
const obj = { ...h, currentPrice: price, valueNative, valueEUR: valueInEur, unrealizedEUR: priceReturnEUR, priceReturnEUR, currencyEffectEUR, totalReturnEUR: priceReturnEUR !== null ? priceReturnEUR + currencyEffectEUR : null, yieldOnCost: investYieldOnCost(h, dividends), investedEUR: investedInEur, currentYield: price ? last12mPerShare / price : null, padiEUR: hPadiEUR, cagr1y: cagrH.cagr1y, cagr3y: cagrH.cagr3y, cagr5y: cagrH.cagr5y, cagr10y: cagrH.cagr10y };
return { obj, valueInEur, investedInEur, investedInEurHist, hPadiEUR };
}));
for (const r of holdingResults) {
if (r.valueInEur !== null) valueEUR += r.valueInEur;
investedEUR += r.investedInEur;
investedEURHistorical += r.investedInEurHist;
padiEUR += r.hPadiEUR;
enriched.push(r.obj);
}
const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
for (const d of dividends) {
const fx = fxMap[d.currency] != null ? fxMap[d.currency] : await investGetFxRate(d.currency, 'EUR');
const amountEUR = d.totalAmount * fx;
dividendAllTimeEUR += amountEUR;
if (new Date(d.payDate).getTime() >= oneYearAgo) dividendYtdEUR += amountEUR;
}
const currencyEffectEURTotal = investedEUR - investedEURHistorical;
const padi12mAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
const padi24mAgo = Date.now() - 730 * 24 * 60 * 60 * 1000;
let padiPrior12mEUR = 0;
for (const d of dividends) {
const dt = new Date(d.payDate).getTime();
if (dt >= padi24mAgo && dt < padi12mAgo) {
const fxp = fxMap[d.currency] != null ? fxMap[d.currency] : await investGetFxRate(d.currency, 'EUR');
padiPrior12mEUR += d.totalAmount * fxp;
}
}
const padiGrowthPct = padiPrior12mEUR > 0 ? (dividendYtdEUR - padiPrior12mEUR) / padiPrior12mEUR : null;
const cashByCurrency = {};
const investAddCash = (currency, amount) => { if (!currency) return; cashByCurrency[currency] = (cashByCurrency[currency] || 0) + amount; };
for (const t of transactions) {
const gross = (t.shares || 0) * (t.price || 0);
const fees = t.fees || 0;
if (t.type === 'buy') investAddCash(t.currency, -(gross + fees));
else if (t.type === 'sell') investAddCash(t.currency, gross - fees);
}
for (const d of dividends) investAddCash(d.currency, d.totalAmount || 0);
for (const o of others) {
const amt = o.amount || 0;
if (o.type === 'deposit' || o.type === 'interest' || o.type === 'corporate-action' || o.type === 'securities-lending') investAddCash(o.currency, amt);
else if (o.type === 'withdrawal' || o.type === 'broker-fee') investAddCash(o.currency, -amt);
}
let cashEUR = 0;
for (const [cur, amt] of Object.entries(cashByCurrency)) {
const fxc = fxMap[cur] != null ? fxMap[cur] : await investGetFxRate(cur, 'EUR');
cashEUR += amt * fxc;
}
return json(res, 200, {
holdings: enriched,
totals: {
valueEUR: valueEUR + cashEUR, investedEUR, unrealizedEUR: valueEUR - investedEUR,
unrealizedPct: investedEUR > 0 ? (valueEUR - investedEUR) / investedEUR : 0,
investedEURHistorical, currencyEffectEUR: currencyEffectEURTotal,
totalReturnEUR: valueEUR - investedEURHistorical,
dividendYtdEUR, dividendAllTimeEUR,
avgYieldOnCost: investedEUR > 0 ? dividendYtdEUR / investedEUR : 0,
padiEUR, padiGrowthPct,
cashEUR, cashByCurrency, positionsValueEUR: valueEUR,
},
});
} catch (e) {
console.error('invest holdings API error:', e.message);
return json(res, 500, { error: 'Kon holdings niet berekenen.' });
}
}

async function handleInvestDividendGrowth(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const portfolioId = investPortfolioIdFromReq(req, new URL(req.url, 'http://localhost'), null);
const dividends = (await kvGetJson(investDivKey(s.email, portfolioId))) || [];
const filterSymbol = String(new URL(req.url, 'http://localhost').searchParams.get('symbol') || '').trim();
const filteredDividends = filterSymbol ? dividends.filter((d) => d.symbol === filterSymbol) : dividends;
const byYear = new Map();
const byMonth = new Map();
for (const d of filteredDividends) {
const fx = await investGetFxRate(d.currency, 'EUR');
const amountEUR = d.totalAmount * fx;
const year = String(d.payDate).slice(0, 4);
const month = String(d.payDate).slice(0, 7);
byYear.set(year, (byYear.get(year) || 0) + amountEUR);
byMonth.set(month, (byMonth.get(month) || 0) + amountEUR);
}
const yearly = [...byYear.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([year, totalEUR]) => ({ year, totalEUR }));
const monthly = [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, totalEUR]) => ({ month, totalEUR }));
const currentYear = String(new Date().getFullYear());
const completed = yearly.filter((y) => y.year !== currentYear);
const cagr = (years) => {
const n = completed.length;
if (n < years + 1) return null;
const start = completed[n - 1 - years].totalEUR;
const end = completed[n - 1].totalEUR;
if (!start || start <= 0) return null;
return Math.pow(end / start, 1 / years) - 1;
};
return json(res, 200, { yearly, monthly, cagr1y: cagr(1), cagr3y: cagr(3), cagr5y: cagr(5), cagr10y: cagr(10) });
} catch (e) {
console.error('invest dividend growth API error:', e.message);
return json(res, 500, { error: 'Kon dividendgroei niet berekenen.' });
}
}

function investSnapKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investsnap:${email}:${portfolioId}` : `investsnap:${email}`; }

async function investGetPriceHistory(symbol, days) {
  return investCached(`investpricehist:${symbol}:${days}`, 6 * 60 * 60 * 1000, async () => {
    const r = await tdFetch('/time_series', { symbol, interval: '1day', outputsize: days })
    const vals = r && r.values
    if (r.error || !vals || !vals.length) return []
    return vals.map((v) => ({ date: v.datetime, close: parseFloat(v.close) })).reverse()
  })
}

function investComputeDrawdownSeries(history) {
  let peak = -Infinity
  let peakDate = null
  let maxDrawdown = 0
  let maxDrawdownDate = null
  let longestDrawdownDays = 0
  let currentDrawdownStart = null
  const series = []
  for (const pt of history) {
    if (pt.valueEUR > peak) {
      peak = pt.valueEUR
      peakDate = pt.date
      if (currentDrawdownStart) {
        const days = Math.round((new Date(pt.date) - new Date(currentDrawdownStart)) / 86400000)
        if (days > longestDrawdownDays) longestDrawdownDays = days
        currentDrawdownStart = null
      }
    } else if (pt.valueEUR < peak) {
      if (!currentDrawdownStart) currentDrawdownStart = peakDate
    }
    const dd = peak > 0 ? (pt.valueEUR - peak) / peak : 0
    if (dd < maxDrawdown) { maxDrawdown = dd; maxDrawdownDate = pt.date }
    series.push({ date: pt.date, valueEUR: pt.valueEUR, peak, drawdown: dd })
  }
  let ongoingDrawdownDays = 0
  if (currentDrawdownStart && history.length) {
    const lastDate = history[history.length - 1].date
    ongoingDrawdownDays = Math.round((new Date(lastDate) - new Date(currentDrawdownStart)) / 86400000)
    if (ongoingDrawdownDays > longestDrawdownDays) longestDrawdownDays = ongoingDrawdownDays
  }
  const last = series.length ? series[series.length - 1] : null
  return {
    series,
    currentDrawdown: last ? last.drawdown : 0,
    lastAth: { date: peakDate, valueEUR: peak > -Infinity ? peak : null },
    maxDrawdown,
    maxDrawdownDate,
    longestDrawdownDays,
  }
}

async function investComputePositionDrawdowns(holdings) {
  const results = []
  for (const h of holdings) {
    const hist = await investGetPriceHistory(h.symbol, 252)
    if (!hist || !hist.length) { results.push({ symbol: h.symbol, currentDrawdown: null, maxDrawdown: null }); continue }
    let peak = -Infinity
    let maxDD = 0
    for (const pt of hist) {
      if (pt.close > peak) peak = pt.close
      const dd = peak > 0 ? (pt.close - peak) / peak : 0
      if (dd < maxDD) maxDD = dd
    }
    const last = hist[hist.length - 1]
    const currentDD = peak > 0 ? (last.close - peak) / peak : 0
    results.push({ symbol: h.symbol, currentDrawdown: currentDD, maxDrawdown: maxDD })
  }
  return results
}

async function handleInvestDrawdown(req, res) {
  const s = await getSession(req, 'admin')
  if (!s) return json(res, 401, { error: 'Not logged in' })
  try {
    const __url = new URL(req.url, 'http://localhost')
    const portfolioId = investPortfolioIdFromReq(req, __url, null)
    const history = (await kvGetJson(investSnapKey(s.email, portfolioId))) || []
    const sorted = [...history].sort((a, b) => (a.date < b.date ? -1 : 1))
    const dd = investComputeDrawdownSeries(sorted)
    const transactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || []
    const holdings = investComputeHoldings(transactions).filter((h) => !h.closed)
    const positions = await investComputePositionDrawdowns(holdings)
    return json(res, 200, { series: dd.series, currentDrawdown: dd.currentDrawdown, lastAth: dd.lastAth, maxDrawdown: dd.maxDrawdown, maxDrawdownDate: dd.maxDrawdownDate, longestDrawdownDays: dd.longestDrawdownDays, positions })
  } catch (e) {
    console.error('invest drawdown API error:', e.message)
    return json(res, 500, { error: 'Kon drawdown-analyse niet laden.' })
  }
}

async function investGetHistoricalPrice(symbol, date) {
return investCached(`investhist:${symbol}:${date}`, 365 * 24 * 60 * 60 * 1000, async () => {
const r = await tdFetch('/time_series', { symbol, interval: '1day', start_date: date, end_date: date, outputsize: 1 });
const vals = r && r.values;
if (r.error || !vals || !vals.length) return null;
return parseFloat(vals[0].close);
});
}

async function investSnapshotPortfolio(email, portfolioId) {
try {
const transactions = (await kvGetJson(investTxKey(email, portfolioId))) || [];
if (!transactions.length) return;
const holdings = investComputeHoldings(transactions).filter((h) => !h.closed);
let valueEUR = 0, investedEUR = 0;
for (const h of holdings) {
const quote = await investGetQuote(h.symbol, h.currency);
const fx = await investGetFxRate(h.currency, 'EUR');
const price = quote ? quote.price : null;
if (price != null) valueEUR += price * h.shares * fx;
investedEUR += h.costBasis * fx;
}
const date = new Date().toISOString().slice(0, 10);
const key = investSnapKey(email, portfolioId);
const list = (await kvGetJson(key)) || [];
const idx = list.findIndex((x) => x.date === date);
const entry = { date, valueEUR, investedEUR };
if (idx !== -1) list[idx] = entry; else list.push(entry);
await kvSetJson(key, list);
} catch (e) {
console.error('invest snapshot error:', e.message);
}
}

async function handleInvestValueHistory(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const __url = new URL(req.url, 'http://localhost')
const portfolioId = investPortfolioIdFromReq(req, __url, null)
const history = (await kvGetJson(investSnapKey(s.email, portfolioId))) || []
const presets = { SP500: 'SPY', AEX: 'IAEX', MSCIACWI: 'ACWI' }
const requestedParam = __url.searchParams.get('benchmarks')
const requestedKeys = requestedParam ? requestedParam.split(',').map((x) => x.trim()).filter(Boolean) : ['SP500']
const benchmarks = {}
for (const key of requestedKeys) {
const symbol = presets[key] || key
let series = []
if (history.length) {
const firstValue = history[0].valueEUR
const firstPrice = await investGetHistoricalPrice(symbol, history[0].date)
if (firstPrice) {
for (const h of history) {
const p = await investGetHistoricalPrice(symbol, h.date)
series.push({ date: h.date, valueEUR: p !== null ? firstValue * (p / firstPrice) : null })
}
}
}
benchmarks[key] = series
}
const benchmarkSymbol = (process.env.INVEST_BENCHMARK_SYMBOL || 'SPY').trim()
const benchmark = benchmarks.SP500 || []
return json(res, 200, { history, benchmark, benchmarkSymbol, benchmarks, benchmarkPresets: presets })
} catch (e) {
console.error('invest value history API error:', e.message);
return json(res, 500, { error: 'Kon waardegeschiedenis niet ophalen.' });
}
}

async function handleInvestCosts(req, res) {
const s = await getSession(req, 'admin')
if (!s) return json(res, 401, { error: 'Not logged in' })
try {
const portfolioId = investPortfolioIdFromReq(req, new URL(req.url, 'http://localhost'), null)
const transactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || []
const byMonthMap = new Map()
const byBrokerMap = new Map()
const bySymbolMap = new Map()
let totalEUR = 0
for (const tx of transactions) {
const fees = Number(tx.fees) || 0
if (!fees) continue
const fx = await investGetFxRate(tx.currency, 'EUR')
const feesEUR = fees * fx
totalEUR += feesEUR
const month = String(tx.date || '').slice(0, 7)
byMonthMap.set(month, (byMonthMap.get(month) || 0) + feesEUR)
const broker = tx.broker || 'Onbekend'
byBrokerMap.set(broker, (byBrokerMap.get(broker) || 0) + feesEUR)
bySymbolMap.set(tx.symbol, (bySymbolMap.get(tx.symbol) || 0) + feesEUR)
}
const toList = (map) => [...map.entries()].map(([key, valueEUR]) => ({ key, valueEUR, pct: totalEUR > 0 ? valueEUR / totalEUR : 0 })).sort((a, b) => b.valueEUR - a.valueEUR)
const byMonth = [...byMonthMap.entries()].map(([month, valueEUR]) => ({ month, valueEUR })).sort((a, b) => (a.month < b.month ? -1 : 1))
return json(res, 200, { byMonth, byBroker: toList(byBrokerMap), bySymbol: toList(bySymbolMap), totalEUR })
} catch (e) {
console.error('invest costs API error:', e.message)
return json(res, 500, { error: 'Kon kostenoverzicht niet berekenen.' })
}
}

function investSectorKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investsector:${email}:${portfolioId}` : `investsector:${email}`; }

function investStrategyKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investstrategy:${email}:${portfolioId}` : `investstrategy:${email}` }

async function investGetInstrumentCountry(symbol) {
return investCached(`investcountry:${symbol}`, 365 * 24 * 60 * 60 * 1000, async () => {
const r = await tdFetch('/stocks', { symbol });
const list = r && r.data;
if (r.error || !list || !list.length) return null;
return list[0].country || null;
});
}

async function investGetInstrumentExchange(symbol) {
return investCached(`investexchange:${symbol}`, 365 * 24 * 60 * 60 * 1000, async () => {
const r = await tdFetch('/stocks', { symbol })
const list = r && r.data
if (r.error || !list || !list.length) return null
return list[0].exchange || null
})
}

async function investGetInstrumentType(symbol) {
return investCached(`investtype:${symbol}`, 365 * 24 * 60 * 60 * 1000, async () => {
const r = await tdFetch('/stocks', { symbol })
const list = r && r.data
if (r.error || !list || !list.length) return null
return list[0].type || null
})
}

const INVEST_CONTINENT_MAP = {
'United States': 'Noord-Amerika', 'Canada': 'Noord-Amerika', 'Mexico': 'Noord-Amerika',
'Netherlands': 'Europa', 'Germany': 'Europa', 'France': 'Europa', 'United Kingdom': 'Europa', 'Belgium': 'Europa', 'Spain': 'Europa', 'Italy': 'Europa', 'Switzerland': 'Europa', 'Sweden': 'Europa', 'Norway': 'Europa', 'Denmark': 'Europa', 'Finland': 'Europa', 'Ireland': 'Europa', 'Austria': 'Europa', 'Portugal': 'Europa', 'Poland': 'Europa', 'Luxembourg': 'Europa',
'Japan': 'Azie', 'China': 'Azie', 'Hong Kong': 'Azie', 'South Korea': 'Azie', 'Taiwan': 'Azie', 'India': 'Azie', 'Singapore': 'Azie', 'Israel': 'Azie',
'Australia': 'Oceanie', 'New Zealand': 'Oceanie',
'Brazil': 'Zuid-Amerika', 'Argentina': 'Zuid-Amerika', 'Chile': 'Zuid-Amerika',
'South Africa': 'Afrika',
}
function investContinentFor(country) { return INVEST_CONTINENT_MAP[country] || 'Onbekend' }

function investBrokerForSymbol(transactions, symbol) {
const matches = transactions.filter((t) => t.symbol === symbol && t.broker).sort((a, b) => (a.date < b.date ? 1 : -1))
return matches.length ? matches[0].broker : null
}

function investStrategyDefsKey(email, portfolioId) { return (portfolioId && portfolioId !== 'default') ? `investstrategydefs:${email}:${portfolioId}` : `investstrategydefs:${email}`; }

async function applyInvestStrategyDefAction(email, portfolioId, body) {
  const key = investStrategyDefsKey(email, portfolioId)
  let list = (await kvGetJson(key)) || []
  if (body.action === 'create') {
    const name = String(body.name || '').trim().slice(0, 40)
    if (!name) throw apiError(400, 'Vul een naam in.')
    list.push({
      id: crypto.randomUUID(),
      name,
      icon: String(body.icon || '').trim().slice(0, 8),
      color: /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? body.color : '#4f8cff',
    })
  } else if (body.action === 'update') {
    const it = list.find((x) => x.id === body.id)
    if (!it) throw apiError(404, 'Niet gevonden')
    if (body.name !== undefined) it.name = String(body.name).trim().slice(0, 40) || it.name
    if (body.icon !== undefined) it.icon = String(body.icon).trim().slice(0, 8)
    if (body.color !== undefined) it.color = /^#[0-9a-fA-F]{6}$/.test(String(body.color)) ? body.color : it.color
  } else if (body.action === 'delete') {
    list = list.filter((x) => x.id !== body.id)
  } else {
    throw apiError(400, 'Onbekende actie')
  }
  await kvSetJson(key, list)
  return list
}

async function handleInvestStrategyDefs(req, res) {
  const s = await getSession(req, 'admin')
  if (!s) return json(res, 401, { error: 'Not logged in' })
  try {
    const __url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET') return json(res, 200, (await kvGetJson(investStrategyDefsKey(s.email, investPortfolioIdFromReq(req, __url, null)))) || [])
    if (req.method === 'POST') {
      const body = await readBody(req, res)
      if (!body) return
      const list = await applyInvestStrategyDefAction(s.email, investPortfolioIdFromReq(req, __url, body), body)
      return json(res, 200, { ok: true, items: list })
    }
  } catch (e) {
    if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message })
    console.error('invest strategy-defs API error:', e.message)
    return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' })
  }
}

async function handleInvestDiversification(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const __url = new URL(req.url, 'http://localhost');
let portfolioId = investPortfolioIdFromReq(req, __url, null);
if (req.method === 'POST') {
const body = await readBody(req, res);
if (!body) return;
if (body.portfolioId) portfolioId = investPortfolioIdFromReq(req, __url, body);
const symbol = String(body.symbol || '').trim();
if (!symbol) return json(res, 400, { error: 'Ticker is verplicht.' });
const sector = String(body.sector || '').trim();
const key = investSectorKey(s.email, portfolioId);
const map = (await kvGetJson(key)) || {};
if (sector) map[symbol] = sector; else delete map[symbol];
await kvSetJson(key, map);
if (body.strategy !== undefined) {
const stratKey = investStrategyKey(s.email, portfolioId)
const stratMap = (await kvGetJson(stratKey)) || {}
const strategy = String(body.strategy || '').trim()
if (strategy) stratMap[symbol] = strategy; else delete stratMap[symbol]
await kvSetJson(stratKey, stratMap)
}
}
const transactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || [];
const holdings = investComputeHoldings(transactions).filter((h) => !h.closed);
const sectorMap = (await kvGetJson(investSectorKey(s.email, portfolioId))) || {};
const byCountryMap = new Map();
const bySectorMap = new Map();
const strategyMap = (await kvGetJson(investStrategyKey(s.email, portfolioId))) || {}
    const strategyDefs = (await kvGetJson(investStrategyDefsKey(s.email, portfolioId))) || []
const byWorldPartMap = new Map()
const byCurrencyMap = new Map()
const byExchangeMap = new Map()
const byAssetTypeMap = new Map()
const byStrategyMap = new Map()
const byBrokerMap = new Map()
let total = 0;
for (const h of holdings) {
const quote = await investGetQuote(h.symbol, h.currency);
const fx = await investGetFxRate(h.currency, 'EUR');
const price = quote ? quote.price : null;
const valueEUR = price != null ? price * h.shares * fx : 0;
total += valueEUR;
const country = (await investGetInstrumentCountry(h.symbol)) || 'Onbekend';
byCountryMap.set(country, (byCountryMap.get(country) || 0) + valueEUR);
const sector = sectorMap[h.symbol] || 'Onbekend';
bySectorMap.set(sector, (bySectorMap.get(sector) || 0) + valueEUR);
const continent = investContinentFor(country)
byWorldPartMap.set(continent, (byWorldPartMap.get(continent) || 0) + valueEUR)
byCurrencyMap.set(h.currency, (byCurrencyMap.get(h.currency) || 0) + valueEUR)
const exchange = (await investGetInstrumentExchange(h.symbol)) || 'Onbekend'
byExchangeMap.set(exchange, (byExchangeMap.get(exchange) || 0) + valueEUR)
const assetType = (await investGetInstrumentType(h.symbol)) || 'Onbekend'
byAssetTypeMap.set(assetType, (byAssetTypeMap.get(assetType) || 0) + valueEUR)
const strategy = strategyMap[h.symbol] || 'Onbekend'
byStrategyMap.set(strategy, (byStrategyMap.get(strategy) || 0) + valueEUR)
const broker = investBrokerForSymbol(transactions, h.symbol) || 'Onbekend'
byBrokerMap.set(broker, (byBrokerMap.get(broker) || 0) + valueEUR)
}
const toList = (map) => [...map.entries()].map(([key, valueEUR]) => ({ key, valueEUR, pct: total > 0 ? valueEUR / total : 0 })).sort((a, b) => b.valueEUR - a.valueEUR);
return json(res, 200, { byCountry: toList(byCountryMap), bySector: toList(bySectorMap), byWorldPart: toList(byWorldPartMap), byCurrency: toList(byCurrencyMap), byExchange: toList(byExchangeMap), byAssetType: toList(byAssetTypeMap), byStrategy: toList(byStrategyMap), byBroker: toList(byBrokerMap), totalValueEUR: total, sectors: sectorMap, strategies: strategyMap, strategyDefs, holdings: holdings.map((h) => ({ symbol: h.symbol, name: h.name })) })
} catch (e) {
if (e && e.httpStatus) return json(res, e.httpStatus, { error: e.message });
console.error('invest diversification API error:', e.message);
return json(res, 500, { error: 'Kon diversificatie niet berekenen.' });
}
}

async function handleInvestDividendCalendar(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const portfolioId = investPortfolioIdFromReq(req, new URL(req.url, 'http://localhost'), null);
const transactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || [];
const holdings = investComputeHoldings(transactions).filter((h) => !h.closed);
const upcoming = [];
for (const h of holdings) {
const history = await investGetDividendHistory(h.symbol);
const est = investEstimateNextDividend(history);
if (est) upcoming.push({ symbol: h.symbol, name: h.name, estimatedDate: est.estimatedDate, amountPerShare: est.amountPerShare, currency: h.currency, confidence: 'estimate' });
}
upcoming.sort((a, b) => (a.estimatedDate < b.estimatedDate ? -1 : 1));
return json(res, 200, { upcoming });
} catch (e) {
console.error('invest dividend-calendar API error:', e.message);
return json(res, 500, { error: 'Kon dividendkalender niet ophalen.' });
}
}
const INVEST_MACRO_EVENTS_2026 = [
  { date: '2026-01-28', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-03-18', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-03-19', title: 'ECB rentebesluit (eurozone)' },
  { date: '2026-04-29', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-04-30', title: 'ECB rentebesluit (eurozone)' },
  { date: '2026-06-11', title: 'ECB rentebesluit (eurozone)' },
  { date: '2026-06-17', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-07-23', title: 'ECB rentebesluit (eurozone)' },
  { date: '2026-07-29', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-09-10', title: 'ECB rentebesluit (eurozone)' },
  { date: '2026-09-16', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-10-28', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-10-29', title: 'ECB rentebesluit (eurozone)' },
  { date: '2026-12-09', title: 'FOMC rentebesluit (VS)' },
  { date: '2026-12-17', title: 'ECB rentebesluit (eurozone)' },
]

async function handleInvestExtendedCalendar(req, res) {
const s = await getSession(req, 'admin')
if (!s) return json(res, 401, { error: 'Not logged in' })
try {
const __url = new URL(req.url, 'http://localhost')
const portfolioId = investPortfolioIdFromReq(req, __url, null)
const transactions = (await kvGetJson(investTxKey(s.email, portfolioId))) || []
const holdings = investComputeHoldings(transactions).filter((h) => !h.closed)
const events = []
for (const h of holdings) {
const history = await investGetDividendHistory(h.symbol)
const est = investEstimateNextDividend(history)
if (est) events.push({ category: 'dividend', date: est.estimatedDate, title: h.symbol + ' verwacht dividend', symbol: h.symbol, amountPerShare: est.amountPerShare, currency: h.currency })
}
for (const m of INVEST_MACRO_EVENTS_2026) events.push({ category: 'macro', date: m.date, title: m.title })
events.sort((a, b) => (a.date < b.date ? -1 : 1))
const categories = [
{ key: 'dividend', label: 'Ex-dividend/dividend', available: true },
{ key: 'macro', label: 'Macro-economische data', available: true },
{ key: 'earnings', label: 'Kwartaal/jaarcijfers', available: false },
{ key: 'trading-updates', label: 'Handelsupdates', available: false },
{ key: 'investor-days', label: 'Beleggersdagen', available: false },
{ key: 'agm', label: 'Aandeelhoudersvergaderingen', available: false },
]
return json(res, 200, { events, categories })
} catch (e) {
console.error('invest extended-calendar API error:', e.message)
return json(res, 500, { error: 'Kon kalender niet ophalen.' })
}
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
createdAt: gymValidCreatedAt(body.createdAt) || Date.now(),
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
if (body.createdAt !== undefined) { const ca = gymValidCreatedAt(body.createdAt); if (ca) it.createdAt = ca; }
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
function gymSplitKey(email) { return `gymsplit:${email}`; }

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
const body = await readBody(req, res);
if (!body) return;
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

async function handleGymSplit(req, res) {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
const key = gymSplitKey(s.email);
try {
if (req.method === 'GET') return json(res, 200, (await kvGetJson(key)) || { order: [], currentIndex: 0 });
if (req.method === 'POST') {
const body = await readBody(req, res);
if (!body) return;
let sched = (await kvGetJson(key)) || { order: [], currentIndex: 0 };
if (body.action === 'setOrder') {
const order = Array.isArray(body.order) ? body.order.map((x) => String(x).slice(0, 100)).slice(0, 20) : [];
sched = { order, currentIndex: sched.currentIndex >= order.length ? 0 : sched.currentIndex };
} else if (body.action === 'setIndex') {
const idx = Number(body.index);
const max = Math.max(0, sched.order.length - 1);
sched = { order: sched.order, currentIndex: sched.order.length ? Math.min(max, Math.max(0, Number.isFinite(idx) ? idx : 0)) : 0 };
} else {
return json(res, 400, { error: 'Onbekende actie' });
}
await kvSetJson(key, sched);
return json(res, 200, sched);
}
} catch (e) {
console.error('gym split API error:', e.message);
return json(res, 500, { error: 'Opslag niet bereikbaar. Is Upstash gekoppeld?' });
}
}

// ---------- Server ----------

async function handleRequest(req, res) {
const url = new URL(req.url, 'http://localhost');
const p = url.pathname;
const ip = clientIp(req);

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
// --- Base PWA: pushmeldingen + widget-feed ---
if (p === '/api/push/vapid-public') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try { const k = await getVapidKeys(); return json(res, 200, { key: k.publicKey }); }
catch (e) { return json(res, 500, { error: 'Opslag niet bereikbaar.' }); }
}
if (p === '/api/push/subscribe' && req.method === 'POST') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const body = await readBody(req, res);
if (!body) return;
const sub = body.subscription;
if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json(res, 400, { error: 'Ongeldige subscription.' });
const key = pushSubsKey(s.email);
let subs = null;
try { subs = await kvGetJson(key); } catch (e) {}
subs = (subs || []).filter((x) => x.endpoint !== sub.endpoint);
subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ua: String(body.ua || '').slice(0, 120), addedAt: Date.now() });
await kvSetJson(key, subs.slice(-10));
logEvent('push', 'apparaat aangemeld voor pushmeldingen');
return json(res, 200, { ok: true, devices: subs.length });
} catch (e) { return json(res, 500, { error: 'Aanmelden mislukt: ' + e.message }); }
}
if (p === '/api/push/unsubscribe' && req.method === 'POST') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const body = await readBody(req, res);
if (!body) return;
const key = pushSubsKey(s.email);
let subs = null;
try { subs = await kvGetJson(key); } catch (e) {}
subs = (subs || []).filter((x) => x.endpoint !== String(body.endpoint || ''));
await kvSetJson(key, subs);
return json(res, 200, { ok: true, devices: subs.length });
} catch (e) { return json(res, 500, { error: 'Afmelden mislukt: ' + e.message }); }
}
if (p === '/api/push/test' && req.method === 'POST') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
try {
const out = await pushToAll(s.email, { title: 'Base', body: 'Testmelding: pushmeldingen werken op dit apparaat.', url: '/base', tag: 'test' });
return json(res, 200, out);
} catch (e) { return json(res, 500, { error: 'Test mislukt: ' + e.message }); }
}
if (p === '/api/widget/token') {
const s = await getSession(req, 'admin');
if (!s) return json(res, 401, { error: 'Not logged in' });
if (s.email !== ADMIN_EMAIL) return json(res, 403, { error: 'Geen toegang' });
try { return json(res, 200, { token: await getWidgetToken() }); }
catch (e) { return json(res, 500, { error: 'Opslag niet bereikbaar.' }); }
}
if (p === '/api/widget/timeline') {
try {
const tk = await getWidgetToken();
const given = url.searchParams.get('token');
if (!given || given !== tk) return json(res, 403, { error: 'Forbidden' });
return json(res, 200, await widgetTimelineData());
} catch (e) { return json(res, 500, { error: e.message }); }
}
if (p === '/api/cron/push') {
const secret = (process.env.CRON_SECRET || '').trim();
if (!secret || url.searchParams.get('key') !== secret) {
return json(res, 403, { error: 'Forbidden' });
}
try { return json(res, 200, await pushDueReminderCheck()); }
catch (e) { console.error('push cron error:', e.message); return json(res, 500, { error: e.message }); }
}

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
if (p === '/api/gym/split') return handleGymSplit(req, res);

// --- Beleggen API (dividend-tracker, admin session) ---
if (p === '/api/invest/transactions') return handleInvestTx(req, res);
if (p === '/api/invest/dividends') return handleInvestDiv(req, res);
if (p === '/api/invest/holdings') return handleInvestHoldings(req, res);
if (p === '/api/invest/dividend-calendar') return handleInvestDividendCalendar(req, res);
if (p === '/api/invest/extended-calendar') return handleInvestExtendedCalendar(req, res)
if (p === '/api/invest/dividend-growth') return handleInvestDividendGrowth(req, res);
if (p === '/api/invest/value-history') return handleInvestValueHistory(req, res);
if (p === '/api/invest/diversification') return handleInvestDiversification(req, res);
if (p === '/api/invest/portfolios') return handleInvestPortfolios(req, res);
if (p === '/api/invest/timetravel') return handleInvestTimetravel(req, res)
if (p === '/api/invest/costs') return handleInvestCosts(req, res)
if (p === '/api/invest/position') return handleInvestPositionDetail(req, res)
if (p === '/api/invest/other-actions') return handleInvestOther(req, res)
if (p === '/api/invest/action-log') return handleInvestActionLog(req, res)
if (p === '/api/invest/mwrr') return handleInvestMwrr(req, res)
if (p === '/api/invest/settings') return handleInvestSettings(req, res)
if (p === '/api/invest/strategy-defs') return handleInvestStrategyDefs(req, res)
if (p === '/api/invest/drawdown') return handleInvestDrawdown(req, res)


// --- Base Assistant API (AI chat widget, same 'admin' session as Gym) ---
if (p === '/api/assistant/history') return handleAssistantHistory(req, res);
if (p === '/api/assistant/chat') return handleAssistantChat(req, res);
if (p === '/api/assistant/clear') return handleAssistantClear(req, res);
    if (p === '/api/assistant/newsession') return handleAssistantNewSession(req, res);
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const body = await readBody(req, res);
if (!body) return;
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
const cronPortfolios = await investGetPortfolios(ADMIN_EMAIL);
for (const cronPf of cronPortfolios) await investSnapshotPortfolio(ADMIN_EMAIL, cronPf.id);
const range = url.searchParams.get('range');
const text = range === 'week' ? await weeklySummaryText() : await dailySummaryText();
const ok = await tgSend(text);
logEvent('dagoverzicht', ok ? 'verstuurd via Telegram' : 'Telegram niet gekoppeld');
const emailDigestResults = await investRunEmailDigests();
return json(res, 200, { ok, summary: text, emailDigests: emailDigestResults });
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
const body = await readBody(req, res);
if (!body) return;
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

// --- Base PWA assets (publiek, geen sessie nodig zodat installeren ook vanaf het loginscherm werkt) ---
if (p === '/base/manifest.webmanifest') {
res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' });
return res.end(PWA_MANIFEST);
}
if (PWA_ICONS[p]) {
res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
return res.end(PWA_ICONS[p]);
}
if (p === '/sw.js') {
res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/base', 'Cache-Control': 'no-cache' });
return res.end(PWA_SW);
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
res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders() });
res.end('Not found');
}

// C-02: de router was één async callback zonder catch, dus elke throw was een
// volledige storing in plaats van een 500.
const server = http.createServer((req, res) => {
handleRequest(req, res).catch((err) => {
console.error('unhandled request error:', (err && (err.stack || err.message)) || String(err));
if (res.writableEnded) return;
if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
res.end(JSON.stringify({ error: 'Interne fout.' }));
});
});

// Laatste vangnet: een losse rejection elders logt voortaan in plaats van het
// proces te beeindigen.
process.on('unhandledRejection', (reason) => {
console.error('unhandledRejection:', (reason && (reason.stack || reason.message)) || String(reason));
});
process.on('uncaughtException', (err) => {
console.error('uncaughtException:', (err && (err.stack || err.message)) || String(err));
});

// Cleanup expired sessions/codes hourly
setInterval(() => {
const now = Date.now();
for (const realm of Object.keys(sessionStores)) {
for (const [k, v] of sessionStores[realm]) if (now > v.expires) sessionStores[realm].delete(k);
}
for (const [k, v] of codes) if (now > v.expires) codes.delete(k);
// M-03: verlopen rate-limit emmers weggooien, anders is de map zelf een lek.
for (const [k, v] of rateLimit) if (now > v.resetAt) rateLimit.delete(k);
}, 60 * 60 * 1000).unref();

// Ingebouwde push-check: elke 5 minuten kijken of er een reminder met tijd
// zojuist is verstreken (pushDueReminderCheck dedupliceert zelf via de
// pushsent-sleutels). Zolang de server draait is er zo geen externe
// cron-dienst nodig; /api/cron/push blijft bestaan als handmatige of externe
// trigger. Direct na het opstarten draait ook een inhaalcheck (vangnet van
// 45 min), zodat een net-wakkere instance gemiste meldingen alsnog stuurt.
setInterval(() => {
pushDueReminderCheck().catch((e) => console.error('push interval error:', e.message));
}, 60 * 1000).unref();
setTimeout(() => {
pushDueReminderCheck().catch((e) => console.error('push boot-check error:', e.message));
}, 20 * 1000).unref();

server.listen(PORT, () => {
console.log(`VDK Business Services running on http://localhost:${PORT}`);
if (!smtpConfigured()) console.log('Note: SMTP not configured — 2FA codes are printed to this console (dev mode).');
});
