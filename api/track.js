// Records anonymous page views and lead actions (call, text, email, quote) for the
// team portal's Leads report. No cookies, no IP addresses, nothing personal is stored.
const C = require('./_lib/core');

const EVENTS = ['view', 'call', 'text', 'email', 'quote'];
const BOTS = /bot|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|gtmetrix|facebookexternalhit|embedly|curl|wget|python|node-fetch|axios|vercel/i;
const DAY_TTL = 400 * 86400;

function day(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function cleanPath(p) {
  let s = String(p || '/').split('?')[0].split('#')[0].slice(0, 120);
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/[^a-z0-9\-\/_.]/gi, '');
  if (!s.endsWith('/') && !/\.[a-z]+$/i.test(s)) s += '/';
  return s.replace(/index\.html$/, '') || '/';
}
function source(ref, utm) {
  const u = String(utm || '').toLowerCase().replace(/[^a-z0-9_\-.]/g, '').slice(0, 30);
  if (u) {
    if (/^(gbp|google_?business|gmb)$/.test(u)) return 'Google Business Profile';
    if (u === 'qr' || u.startsWith('qr')) return 'QR code (' + u + ')';
    return 'Tagged: ' + u;
  }
  let host = '';
  try { host = new URL(String(ref || '')).hostname.toLowerCase(); } catch (e) { return 'Direct / typed in'; }
  if (!host || /(^|\.)getdumphero\.com$/.test(host)) return 'Direct / typed in';
  const map = [
    [/google\./, 'Google'], [/bing\.com/, 'Bing'], [/duckduckgo|yahoo|ecosia|brave|yandex|baidu/, 'Other search'],
    [/chatgpt|openai/, 'ChatGPT'], [/perplexity/, 'Perplexity'], [/copilot|edgeservices/, 'Copilot'], [/claude\.ai/, 'Claude'], [/gemini\./, 'Gemini'],
    [/facebook|fb\.|messenger/, 'Facebook'], [/instagram/, 'Instagram'], [/nextdoor/, 'Nextdoor'], [/yelp/, 'Yelp'],
    [/tiktok/, 'TikTok'], [/youtube/, 'YouTube'], [/(^|\.)t\.co$|twitter|x\.com/, 'X / Twitter'], [/linkedin/, 'LinkedIn'],
    [/thumbtack/, 'Thumbtack'], [/angi|homeadvisor/, 'Angi'], [/craigslist/, 'Craigslist'],
  ];
  for (const [re, name] of map) if (re.test(host)) return name;
  return host.replace(/^www\./, '').slice(0, 40);
}

async function pipeline(cmds) {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return false;
  const r = await fetch(url + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
  });
  return r.ok;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'POST') { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, storage: C.hasStorage() })); }
  try {
    if (BOTS.test(String(req.headers['user-agent'] || ''))) { res.statusCode = 204; return res.end(); }
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (!body || typeof body !== 'object') body = {};
    const e = EVENTS.includes(body.e) ? body.e : null;
    if (!e) { res.statusCode = 400; return res.end(); }
    const path = cleanPath(body.p);
    if (path.startsWith('/portal') || path.startsWith('/api')) { res.statusCode = 204; return res.end(); }
    const src = source(body.r, body.u);
    const key = 'dh:st:' + day();
    const cmds = [];
    if (e === 'view') {
      cmds.push(['HINCRBY', key, 'v|' + path, 1]);
      if (body.f) { cmds.push(['HINCRBY', key, 's|' + src, 1]); cmds.push(['HINCRBY', key, 'l|' + path, 1]); }
    } else {
      cmds.push(['HINCRBY', key, e + '|' + path, 1]);
      cmds.push(['HINCRBY', key, e + '@' + src, 1]);
      const where = String(body.w || '').replace(/[^a-z0-9 \-_]/gi, '').slice(0, 30);
      cmds.push(['LPUSH', 'dh:leadlog', JSON.stringify({ t: new Date().toISOString(), e, p: path, w: where, s: src, lp: cleanPath(body.lp || path) })]);
      cmds.push(['LTRIM', 'dh:leadlog', 0, 499]);
    }
    cmds.push(['EXPIRE', key, DAY_TTL]);
    await pipeline(cmds);
  } catch (err) { console.error('track', err); }
  res.statusCode = 204; res.end();
};
module.exports.source = source;
