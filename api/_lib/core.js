// Shared helpers for the Dump Hero team portal (not a public endpoint).
const crypto = require('crypto');

class PortalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const COOKIE = 'dh_portal';
const SESSION_DAYS = 7;

function env(name) { return process.env[name] || ''; }

// ---------- storage (Upstash Redis REST, connected through Vercel) ----------
function redisConf() {
  const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}
function hasStorage() { return !!redisConf(); }
async function redis(cmd) {
  const c = redisConf();
  if (!c) throw new PortalError(503, 'Shared storage is not set up yet. Connect an Upstash Redis database to this project in Vercel.');
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new PortalError(502, 'Storage error: ' + (j.error || r.status));
  return j.result;
}

// ---------- users ----------
function loadUsers() {
  let raw = env('PORTAL_USERS');
  if (!raw) return {};
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { console.error('PORTAL_USERS is not valid JSON'); return {}; }
  const out = {};
  Object.keys(obj || {}).forEach((name) => {
    const hash = String(obj[name] || '');
    if (name && hash.startsWith('pbkdf2$')) out[name.toLowerCase()] = { name, hash };
  });
  return out;
}
function userNames() { return Object.values(loadUsers()).map((u) => u.name); }

const DUMMY = 'pbkdf2$sha256$310000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iter = parseInt(parts[2], 10);
  if (!(iter >= 100000 && iter <= 2000000)) return false;
  const salt = Buffer.from(parts[3], 'base64');
  const expected = Buffer.from(parts[4], 'base64');
  if (!salt.length || !expected.length) return false;
  const derived = crypto.pbkdf2Sync(String(password), salt, iter, expected.length, 'sha256');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
function fingerprint(hash) { return crypto.createHash('sha256').update(hash).digest('base64url').slice(0, 12); }

// ---------- sessions ----------
function secret() {
  const s = env('PORTAL_SESSION_SECRET');
  if (s.length < 32) throw new PortalError(503, 'The portal is not set up yet (PORTAL_SESSION_SECRET is missing or too short).');
  return s;
}
function hmac(data) { return crypto.createHmac('sha256', secret()).update(data).digest('base64url'); }
function makeToken(user) {
  const payload = { u: user.name, f: fingerprint(user.hash), e: Date.now() + SESSION_DAYS * 86400000 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data + '.' + hmac(data);
}
function readToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 1) return null;
  const [data, sig] = token.split('.');
  let good;
  try { good = hmac(data); } catch (e) { return null; }
  const a = Buffer.from(sig || ''), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.e !== 'number' || p.e < Date.now()) return null;
  const user = loadUsers()[String(p.u || '').toLowerCase()];
  if (!user || fingerprint(user.hash) !== p.f) return null; // user removed or password changed
  return { name: user.name };
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) { return readToken(parseCookies(req)[COOKIE]); }
function sessionCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
function clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }

// ---------- http helpers ----------
function send(res, status, obj, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  Object.entries(extraHeaders || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (typeof req.body === 'string') raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else {
    raw = await new Promise((resolve, reject) => {
      let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) reject(new PortalError(413, 'Request too large')); });
      req.on('end', () => resolve(d)); req.on('error', reject);
    });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw new PortalError(400, 'Invalid request.'); }
}
function requirePost(req) {
  if (req.method !== 'POST') throw new PortalError(405, 'Method not allowed');
  // Custom header blocks cross-site form posts (CSRF); browsers can't add it cross-site without permission.
  if (req.headers['x-portal'] !== '1') throw new PortalError(403, 'Forbidden');
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new PortalError(401, 'Please sign in.');
  return u;
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'; }
function handle(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      const status = err instanceof PortalError ? err.status : 500;
      if (status >= 500) console.error(err);
      send(res, status, { ok: false, error: err instanceof PortalError ? err.message : 'Something went wrong.' });
    }
  };
}

const DEFAULT_SETTINGS = {
  strong: ['debris removal','debris hauling','debris','hauling','haul off','dump trailer','dump truck','trash removal','junk removal','waste removal','solid waste','refuse','dumpster','roll-off','roll off','fill dirt','select fill','topsoil','top soil','gravel','sand','aggregate','crushed concrete','crushed stone','flex base','road base','cleanout','clean out','clean-up','cleanup','storm debris','hurricane','vegetative debris','bulk waste','heavy trash','illegal dumping'],
  support: ['disposal','landfill','removal','trash','garbage','waste','hauled','dirt','soil','rock','limestone','caliche','backfill','demolition','clearing','litter','landscap','drainage','grading','construction debris','furniture','mattress','eviction','move-out','janitorial'],
  naics: ['562111','562119','562998','484220','484110','532490','238910','212321','423320'],
  psc: ['S205','S222','5610'],
  local: ['houston','harris','fort bend','brazoria','galveston','montgomery','waller','chambers','liberty','pasadena','pearland','katy','sugar land','baytown','conroe','league city','missouri city','friendswood','the woodlands','spring','humble','cypress','tomball','richmond','rosenberg','stafford','bellaire','deer park','la porte','webster','seabrook','texas city','angleton','alvin','lake jackson','freeport','770','771','772','773','774','775'],
  neg: ['hazardous','radioactive','asbestos','medical waste','biohazard','nuclear','pcb','lead abatement','infectious','sharps','chemical waste'],
};
async function loadSettings() {
  if (!hasStorage()) return DEFAULT_SETTINGS;
  const raw = await redis(['GET', 'dh:settings']);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const s = JSON.parse(raw); const out = {};
    Object.keys(DEFAULT_SETTINGS).forEach((k) => { out[k] = Array.isArray(s[k]) ? s[k] : DEFAULT_SETTINGS[k]; });
    return out;
  } catch (e) { return DEFAULT_SETTINGS; }
}

module.exports = {
  PortalError, redis, hasStorage, loadUsers, userNames, verifyPassword, DUMMY, makeToken, currentUser,
  sessionCookie, clearCookie, send, readBody, requirePost, requireUser, clientIp, handle, DEFAULT_SETTINGS, loadSettings,
};
