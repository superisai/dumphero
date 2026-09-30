// Pulls fresh listings from SAM.gov and USAspending for the team portal, cached in shared storage.
const C = require('./_lib/core');
const DAY = 86400000;
const CACHE_HOURS = 6;
const COOLDOWN = { sam: 1800, usa: 300 }; // seconds between manual refreshes

function mdy(d) { return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear(); }
function ymd(d) { return d.toISOString().slice(0, 10); }
function s(v, max) { return v == null ? '' : String(v).slice(0, max || 300); }

async function fetchJson(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 20000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, json: j, text: text.slice(0, 300) };
  } finally { clearTimeout(t); }
}

// ---------- SAM.gov ----------
async function samFeed(settings) {
  const key = process.env.SAM_API_KEY;
  if (!key) return { records: [], warnings: ['Add your free SAM.gov API key to Vercel (SAM_API_KEY) to turn on the SAM.gov feed.'], setup: true };
  const now = new Date(), from = new Date(now.getTime() - 90 * DAY);
  const naics = (settings.naics || []).map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length === 6).slice(0, 6);
  const titles = ['debris', 'hauling', 'fill dirt'];
  const queries = naics.map((n) => ({ ncode: n })).concat(titles.map((t) => ({ title: t })));
  const warnings = [];
  const results = await Promise.all(queries.map(async (q) => {
    const p = new URLSearchParams(Object.assign({ api_key: key, postedFrom: mdy(from), postedTo: mdy(now), state: 'TX', limit: '1000', offset: '0' }, q));
    try {
      const r = await fetchJson('https://api.sam.gov/opportunities/v2/search?' + p.toString(), {}, 25000);
      if (!r.ok) { warnings.push('SAM.gov ' + (q.ncode ? 'NAICS ' + q.ncode : '"' + q.title + '"') + ': ' + (r.status === 429 ? 'daily request limit reached, try again later' : 'error ' + r.status)); return []; }
      return (r.json && r.json.opportunitiesData) || [];
    } catch (e) { warnings.push('SAM.gov request timed out.'); return []; }
  }));
  const seen = {}, out = [];
  results.flat().forEach((o) => {
    if (!o || !o.noticeId || seen[o.noticeId]) return; seen[o.noticeId] = 1;
    const pop = o.placeOfPerformance || {}, poc = (o.pointOfContact || [])[0] || {};
    const path = s(o.fullParentPathName, 400).split('.');
    out.push({
      src: 'sam', id: s(o.noticeId, 80), title: s(o.title, 300), agency: s(path[0] || o.department, 150), office: s(path[path.length - 1] || o.subTier, 150),
      posted: s(o.postedDate, 30), deadline: s(o.responseDeadLine, 40), type: s(o.type, 60),
      setaside: s(o.typeOfSetAsideDescription || o.typeOfSetAside, 120), naics: s(o.naicsCode, 20), psc: s(o.classificationCode, 20),
      city: s(pop.city && pop.city.name, 80), state: s(pop.state && (pop.state.code || pop.state.name), 40), zip: s(pop.zip, 12),
      link: s(o.uiLink, 300), contact: s(poc.fullName, 100), email: s(poc.email, 120), phone: s(poc.phone, 40), active: s(o.active, 10),
    });
  });
  out.sort((a, b) => (Date.parse(b.posted) || 0) - (Date.parse(a.posted) || 0));
  return { records: out.slice(0, 800), warnings };
}

// ---------- USAspending ----------
function pick(o, names) { for (const n of names) { if (o[n] != null && o[n] !== '') return o[n]; } return ''; }
function codeOf(v) { return v && typeof v === 'object' ? s(v.code, 20) : s(v, 20); }
function descOf(v) { return v && typeof v === 'object' ? s(v.description, 200) : ''; }
async function usaFeed(settings) {
  const now = new Date(), start = new Date(now.getTime() - 3 * 365 * DAY);
  const naics = (settings.naics || []).map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length >= 2).slice(0, 12);
  const fullFields = ['Award ID', 'Recipient Name', 'Award Amount', 'Start Date', 'End Date', 'Awarding Agency', 'Awarding Sub Agency', 'Description', 'NAICS', 'PSC', 'Place of Performance State Code', 'Place of Performance Zip5'];
  const basicFields = ['Award ID', 'Recipient Name', 'Award Amount', 'Start Date', 'End Date', 'Awarding Agency', 'Awarding Sub Agency', 'Description'];
  const variants = [
    { naics_codes: { require: naics }, fields: fullFields },
    { naics_codes: naics, fields: fullFields },
    { naics_codes: { require: naics }, fields: basicFields },
  ];
  const warnings = [];
  for (const v of variants) {
    const rows = []; let failed = false;
    for (let page = 1; page <= 3; page++) {
      const body = {
        filters: {
          award_type_codes: ['A', 'B', 'C', 'D'], naics_codes: v.naics_codes,
          place_of_performance_locations: [{ country: 'USA', state: 'TX' }],
          time_period: [{ start_date: ymd(start), end_date: ymd(now) }],
        },
        fields: v.fields, page, limit: 100, sort: 'Award Amount', order: 'desc', subawards: false,
      };
      try {
        const r = await fetchJson('https://api.usaspending.gov/api/v2/search/spending_by_award/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);
        if (!r.ok) { failed = true; if (r.status >= 500) warnings.push('USAspending is having trouble right now (error ' + r.status + ').'); break; }
        const res = (r.json && r.json.results) || [];
        rows.push(...res);
        if (!r.json.page_metadata || !r.json.page_metadata.hasNext || res.length < 100) break;
      } catch (e) { failed = true; warnings.push('USAspending request timed out.'); break; }
    }
    if (!failed || rows.length) {
      const out = rows.map((o) => {
        const nx = o['NAICS'], px = o['PSC'], gid = s(o.generated_internal_id, 200);
        return {
          src: 'usa', id: s(pick(o, ['Award ID']), 80), recipient: s(o['Recipient Name'], 150), amount: Number(o['Award Amount']) || 0,
          posted: s(o['Start Date'], 20), enddate: s(o['End Date'], 20), agency: s(o['Awarding Agency'], 150), office: s(o['Awarding Sub Agency'], 150),
          title: s(o['Description'], 300), desc: s(o['Description'], 600), naics: codeOf(nx), naicsdesc: descOf(nx), psc: codeOf(px),
          state: s(o['Place of Performance State Code'] || 'TX', 10), zip: s(o['Place of Performance Zip5'], 10),
          link: gid ? 'https://www.usaspending.gov/award/' + encodeURIComponent(gid) : '',
        };
      });
      return { records: out, warnings };
    }
  }
  return { records: [], warnings: warnings.length ? warnings : ['USAspending did not accept the search. Try again later.'] };
}

module.exports = C.handle(async (req, res) => {
  C.requireUser(req);
  const src = req.query && req.query.source ? String(req.query.source) : new URL(req.url, 'http://x').searchParams.get('source');
  const refresh = (req.query && req.query.refresh) || new URL(req.url, 'http://x').searchParams.get('refresh');
  if (src !== 'sam' && src !== 'usa') throw new C.PortalError(400, 'Unknown source.');
  const storage = C.hasStorage();
  const cacheKey = 'dh:feed:' + src;
  let cached = null;
  if (storage) { const raw = await C.redis(['GET', cacheKey]); if (raw) { try { cached = JSON.parse(raw); } catch (e) {} } }
  const fresh = cached && Date.now() - cached.at < CACHE_HOURS * 3600000;
  if (cached && (fresh && !refresh)) return C.send(res, 200, Object.assign({ ok: true, cached: true }, cached));
  if (refresh && cached && storage) {
    const got = await C.redis(['SET', 'dh:feedlock:' + src, '1', 'NX', 'EX', COOLDOWN[src]]);
    if (!got) return C.send(res, 200, Object.assign({ ok: true, cached: true, note: 'This feed was refreshed a few minutes ago. Showing the latest results.' }, cached));
  }
  const settings = await C.loadSettings();
  const result = src === 'sam' ? await samFeed(settings) : await usaFeed(settings);
  const payload = { at: Date.now(), records: result.records, warnings: result.warnings, setup: !!result.setup };
  if (storage && result.records.length) await C.redis(['SET', cacheKey, JSON.stringify(payload)]);
  if (!result.records.length && cached) return C.send(res, 200, Object.assign({ ok: true, cached: true }, cached, { warnings: result.warnings }));
  C.send(res, 200, Object.assign({ ok: true, cached: false }, payload));
});
