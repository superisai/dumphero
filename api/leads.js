// Serves /portal/leads: which pages and sources bring in calls, texts, emails and quote requests.
const C = require('./_lib/core');

const LABEL = { call: 'Calls', text: 'Texts', email: 'Emails', quote: 'Quote forms' };
const LEADS = ['call', 'text', 'quote', 'email'];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dayStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function when(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

async function pipeline(cmds) {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  const r = await fetch(url + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json();
  return j.map((x) => x.result);
}

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#F3F0EA;--surface:#fff;--line:#DDD7CC;--ink:#1B1A17;--muted:#57534E;--accent:#C2410C;--soft:#FDE8DC}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:26px;margin:0}h2{font-size:18px;margin:28px 0 10px}
a{color:var(--accent)}.muted{color:var(--muted)}
.ranges{display:flex;gap:6px}.ranges a{padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--surface);text-decoration:none;color:var(--ink);font-weight:600}
.ranges a.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.tile b{display:block;font-size:30px;line-height:1.1}.tile span{color:var(--muted);font-size:14px}
.tile.hi{background:var(--soft);border-color:#F4C7AE}
.box{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:520px;font-size:14px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:#FAF8F4}
td.n,th.n{text-align:right}tr:last-child td{border-bottom:0}td.p{white-space:normal;word-break:break-all}
.note{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-top:16px}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--soft);color:#9A3412;font-weight:600;font-size:12px}
</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let user = null;
  try { user = C.currentUser(req); } catch (e) {}
  if (!user) { res.statusCode = 302; res.setHeader('Location', '/portal'); return res.end(); }
  if (!C.hasStorage()) { res.statusCode = 200; return res.end(page('Leads', '<h1>Leads</h1><p>Shared storage is not connected yet, so nothing can be recorded.</p>')); }

  const q = new URL(req.url, 'http://x').searchParams;
  const days = [7, 30, 90].includes(+q.get('days')) ? +q.get('days') : 30;
  const keys = [];
  for (let i = 0; i < days; i++) keys.push('dh:st:' + dayStr(new Date(Date.now() - i * 86400000)));
  let results;
  try { results = await pipeline([...keys.map((k) => ['HGETALL', k]), ['LRANGE', 'dh:leadlog', 0, 199]]); }
  catch (e) { res.statusCode = 200; return res.end(page('Leads', '<h1>Leads</h1><p>Could not load the report right now. Try again in a minute.</p>')); }
  const log = (results.pop() || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

  const pages = {}, sources = {}, landing = {}, tot = { view: 0, visit: 0, call: 0, text: 0, email: 0, quote: 0 };
  const P = (p) => (pages[p] = pages[p] || { view: 0, call: 0, text: 0, email: 0, quote: 0 });
  const S = (s) => (sources[s] = sources[s] || { visit: 0, call: 0, text: 0, email: 0, quote: 0 });
  results.forEach((arr) => {
    for (let i = 0; arr && i < arr.length; i += 2) {
      const f = arr[i], n = +arr[i + 1] || 0;
      let m;
      if ((m = f.match(/^v\|(.*)$/))) { P(m[1]).view += n; tot.view += n; }
      else if ((m = f.match(/^s\|(.*)$/))) { S(m[1]).visit += n; tot.visit += n; }
      else if ((m = f.match(/^l\|(.*)$/))) { landing[m[1]] = (landing[m[1]] || 0) + n; }
      else if ((m = f.match(/^(call|text|email|quote)\|(.*)$/))) { P(m[2])[m[1]] += n; tot[m[1]] += n; }
      else if ((m = f.match(/^(call|text|email|quote)@(.*)$/))) { S(m[2])[m[1]] += n; }
    }
  });
  const leadsOf = (o) => LEADS.reduce((s, k) => s + (o[k] || 0), 0);
  const allLeads = leadsOf(tot);
  const rate = tot.visit ? ((allLeads / tot.visit) * 100).toFixed(1) + '%' : '—';
  const cutoff = Date.now() - days * 86400000;
  const recent = log.filter((x) => Date.parse(x.t) >= cutoff).slice(0, 60);

  const pageRows = Object.entries(pages).sort((a, b) => leadsOf(b[1]) - leadsOf(a[1]) || b[1].view - a[1].view).slice(0, 40)
    .map(([p, o]) => `<tr><td class="p"><a href="${esc(p)}" target="_blank" rel="noopener">${esc(p)}</a></td><td class="n">${o.view}</td><td class="n">${landing[p] || 0}</td>${LEADS.map((k) => `<td class="n">${o[k] || ''}</td>`).join('')}<td class="n"><b>${leadsOf(o) || ''}</b></td></tr>`).join('');
  const srcRows = Object.entries(sources).sort((a, b) => leadsOf(b[1]) - leadsOf(a[1]) || b[1].visit - a[1].visit)
    .map(([s, o]) => `<tr><td>${esc(s)}</td><td class="n">${o.visit}</td>${LEADS.map((k) => `<td class="n">${o[k] || ''}</td>`).join('')}<td class="n"><b>${leadsOf(o) || ''}</b></td></tr>`).join('');
  const logRows = recent.map((x) => `<tr><td>${esc(when(x.t))}</td><td><span class="tag">${esc(({ call: 'Call', text: 'Text', email: 'Email', quote: 'Quote form' })[x.e] || x.e)}</span></td><td class="p">${esc(x.p)}</td><td>${esc(x.w || '')}</td><td>${esc(x.s)}</td><td class="p">${esc(x.lp || '')}</td></tr>`).join('');
  const empty = (cols, text) => `<tr><td colspan="${cols}" class="muted">${text}</td></tr>`;

  const inner = `
<header><div><h1>Leads</h1><div class="muted">Last ${days} days · Houston time · <a href="/portal">Back to portal</a></div></div>
<nav class="ranges">${[7, 30, 90].map((d) => `<a href="?days=${d}" class="${d === days ? 'on' : ''}">${d} days</a>`).join('')}</nav></header>
<div class="tiles">
<div class="tile"><b>${tot.visit}</b><span>Visits</span></div>
<div class="tile"><b>${tot.view}</b><span>Page views</span></div>
<div class="tile hi"><b>${tot.call}</b><span>Call taps</span></div>
<div class="tile hi"><b>${tot.text}</b><span>Text taps</span></div>
<div class="tile hi"><b>${tot.quote}</b><span>Quote forms sent</span></div>
<div class="tile"><b>${tot.email}</b><span>Email taps</span></div>
<div class="tile"><b>${rate}</b><span>Visits that became a lead</span></div>
</div>
<h2>Where leads come from</h2>
<div class="box"><table><tr><th>Source</th><th class="n">Visits</th><th class="n">Calls</th><th class="n">Texts</th><th class="n">Quotes</th><th class="n">Emails</th><th class="n">Leads</th></tr>${srcRows || empty(7, 'No visits recorded yet.')}</table></div>
<h2>Pages</h2>
<div class="box"><table><tr><th>Page</th><th class="n">Views</th><th class="n">Landed here</th><th class="n">Calls</th><th class="n">Texts</th><th class="n">Quotes</th><th class="n">Emails</th><th class="n">Leads</th></tr>${pageRows || empty(8, 'No page views recorded yet.')}</table></div>
<h2>Latest lead actions</h2>
<div class="box"><table><tr><th>When</th><th>Action</th><th>Page</th><th>Button</th><th>Source</th><th>First page of visit</th></tr>${logRows || empty(6, 'No calls, texts or quote requests recorded yet.')}</table></div>
<div class="note muted">A "call" or "text" here means someone tapped the button. Quo shows whether the call actually came through. Your own visits aren't counted on any phone or computer where you've opened <a href="/?notrack">getdumphero.com/?notrack</a> once. Bots and page-speed testers are skipped. Tagged sources come from links ending in <code>?utm_source=…</code>, for example <code>?utm_source=gbp</code> on your Google Business Profile or <code>?utm_source=qr-sign</code> on a printed QR code.</div>`;
  res.statusCode = 200;
  res.end(page('Leads · Dump Hero', inner));
};
