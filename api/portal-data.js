// Shared pipeline, notes and settings for the Dump Hero team portal.
const C = require('./_lib/core');
const crypto = require('crypto');
const KEY = 'dh:pipeline';
const STATUSES = ['Reviewing', 'Bidding', 'Submitted', 'Won', 'Lost', 'Passed'];
const DECISIONS = ['Undecided', 'Bid', 'No bid'];
const CHECKS = ['eligible', 'insurance', 'bonding', 'equipment', 'distance', 'schedule', 'sitevisit', 'questions', 'price', 'submitted'];
const LISTING_FIELDS = ['src', 'id', 'title', 'agency', 'office', 'city', 'county', 'state', 'zip', 'link', 'setaside', 'naics', 'psc', 'score', 'recipient', 'amount', 'enddate', 'contact', 'email', 'phone', 'desc', 'level', 'place', 'type'];
const UPLOAD_FIELDS = ['src', 'id', 'title', 'desc', 'agency', 'office', 'posted', 'deadline', 'type', 'setaside', 'naics', 'naicsdesc', 'psc', 'nigp', 'city', 'county', 'state', 'zip', 'link', 'amount', 'contact', 'email', 'phone', 'active', 'place', 'level', 'popBlank'];
const CONTACT_STATUSES = ['Not contacted', 'Contacted', 'Follow up', 'Partnered', 'Not interested'];
const CONTACT_FIELDS = ['company', 'name', 'role', 'phone', 'email', 'website', 'city', 'source'];
async function hashAll(key) {
  const all = await C.redis(['HGETALL', key]) || []; const out = [];
  for (let i = 1; i < all.length; i += 2) { try { out.push(JSON.parse(all[i])); } catch (e) {} }
  return out;
}
async function getJson(hash, field) { const raw = await C.redis(['HGET', hash, field]); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }

function str(v, max) { return v == null ? '' : String(v).slice(0, max); }
function cleanDate(v) { const s = str(v, 25); return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s) ? s : ''; }
function cleanKey(v) { const s = str(v, 300).trim(); if (!s) throw new C.PortalError(400, 'Missing listing key.'); return s; }

async function getItem(key) {
  const raw = await C.redis(['HGET', KEY, key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function putItem(item) {
  const json = JSON.stringify(item);
  if (json.length > 60000) throw new C.PortalError(413, 'This listing has too many notes to save. Remove a few first.');
  await C.redis(['HSET', KEY, item.key, json]);
  return item;
}

module.exports = C.handle(async (req, res) => {
  const user = C.requireUser(req);
  if (req.method === 'GET') {
    const storage = C.hasStorage();
    const part = new URL(req.url, 'http://x').searchParams.get('part');
    if (part === 'uploads') return C.send(res, 200, { ok: true, storage, sets: storage ? await hashAll('dh:uploads') : [] });
    const items = storage ? await hashAll(KEY) : [];
    const contacts = storage ? await hashAll('dh:contacts') : [];
    return C.send(res, 200, { ok: true, storage, items, contacts, settings: await C.loadSettings(), users: C.userNames(), me: user.name });
  }
  C.requirePost(req);
  const body = await C.readBody(req);
  const now = new Date().toISOString();

  if (body.action === 'save') {
    const l = body.listing || {};
    const key = cleanKey(body.key);
    const existing = await getItem(key);
    if (existing) return C.send(res, 200, { ok: true, item: existing });
    const listing = {};
    LISTING_FIELDS.forEach((f) => { if (l[f] != null && l[f] !== '') listing[f] = f === 'score' || f === 'amount' ? Number(l[f]) || 0 : str(l[f], f === 'desc' ? 1500 : 400); });
    const item = {
      key, listing, status: 'Reviewing', decision: 'Undecided', assignee: user.name, checklist: {},
      dates: { deadline: cleanDate(body.deadline), site: '', questions: '' }, notes: [],
      createdBy: user.name, createdAt: now, updatedBy: user.name, updatedAt: now, version: 1,
    };
    return C.send(res, 200, { ok: true, item: await putItem(item) });
  }

  if (body.action === 'update') {
    const key = cleanKey(body.key);
    const item = await getItem(key);
    if (!item) throw new C.PortalError(404, 'This listing was removed from the pipeline.');
    const f = body.fields || {};
    if (f.status != null) { if (!STATUSES.includes(f.status)) throw new C.PortalError(400, 'Invalid status.'); item.status = f.status; }
    if (f.decision != null) { if (!DECISIONS.includes(f.decision)) throw new C.PortalError(400, 'Invalid decision.'); item.decision = f.decision; }
    if (f.assignee != null) { const names = C.userNames(); item.assignee = f.assignee === '' ? '' : (names.includes(f.assignee) ? f.assignee : item.assignee); }
    if (f.checklist && typeof f.checklist === 'object') CHECKS.forEach((c) => { if (c in f.checklist) item.checklist[c] = !!f.checklist[c]; });
    if (f.dates && typeof f.dates === 'object') ['deadline', 'site', 'questions'].forEach((d) => { if (d in f.dates) item.dates[d] = cleanDate(f.dates[d]); });
    item.updatedBy = user.name; item.updatedAt = now; item.version = (item.version || 1) + 1;
    return C.send(res, 200, { ok: true, item: await putItem(item) });
  }

  if (body.action === 'note') {
    const key = cleanKey(body.key);
    const text = str(body.text, 2000).trim();
    if (!text) throw new C.PortalError(400, 'Write a note first.');
    const item = await getItem(key);
    if (!item) throw new C.PortalError(404, 'This listing was removed from the pipeline.');
    item.notes = (item.notes || []).concat([{ by: user.name, at: now, text }]).slice(-100);
    item.updatedBy = user.name; item.updatedAt = now; item.version = (item.version || 1) + 1;
    return C.send(res, 200, { ok: true, item: await putItem(item) });
  }

  if (body.action === 'delete') {
    await C.redis(['HDEL', KEY, cleanKey(body.key)]);
    return C.send(res, 200, { ok: true });
  }

  if (body.action === 'upload-save') {
    const level = ['state', 'county', 'city'].includes(body.level) ? body.level : null;
    const place = str(body.place, 60).trim();
    if (!level || !place) throw new C.PortalError(400, 'Choose whether this is a state, county or city list, and which one.');
    const recs = (Array.isArray(body.records) ? body.records : []).slice(0, 1000).map((r) => {
      const o = {}; UPLOAD_FIELDS.forEach((f) => { if (r && r[f] != null && r[f] !== '') o[f] = f === 'popBlank' ? !!r[f] : str(r[f], f === 'desc' ? 400 : 200); }); return o;
    }).filter((r) => r.title || r.desc);
    const key = level + ':' + place.toLowerCase();
    const set = { key, level, place, file: str(body.file, 120), by: user.name, at: now, count: recs.length, rows: Number(body.rows) || 0, records: recs };
    const json = JSON.stringify(set);
    if (json.length > 900000) throw new C.PortalError(413, 'This file has too many matching listings to save. Try a smaller date range.');
    await C.redis(['HSET', 'dh:uploads', key, json]);
    return C.send(res, 200, { ok: true, set });
  }
  if (body.action === 'upload-delete') {
    await C.redis(['HDEL', 'dh:uploads', str(body.key, 100)]);
    return C.send(res, 200, { ok: true });
  }

  if (body.action === 'contact-save') {
    const f = body.fields || {};
    let c = body.id ? await getJson('dh:contacts', str(body.id, 40)) : null;
    if (body.id && !c) throw new C.PortalError(404, 'This contact was removed.');
    if (!c) {
      const company = str(f.company, 150).trim();
      if (!company) throw new C.PortalError(400, 'Enter a company name.');
      const count = await C.redis(['HLEN', 'dh:contacts']);
      if (count >= 2000) throw new C.PortalError(400, 'The contact list is full. Remove old contacts first.');
      c = { id: crypto.randomBytes(8).toString('hex'), status: 'Not contacted', notes: [], createdBy: user.name, createdAt: now };
    }
    CONTACT_FIELDS.forEach((k) => { if (k in f) c[k] = str(f[k], k === 'source' ? 400 : 150).trim(); });
    if (f.status != null) { if (!CONTACT_STATUSES.includes(f.status)) throw new C.PortalError(400, 'Invalid status.'); c.status = f.status; }
    if (!c.company) throw new C.PortalError(400, 'Enter a company name.');
    if (body.touch) c.lastContact = { by: user.name, at: now };
    c.updatedBy = user.name; c.updatedAt = now;
    await C.redis(['HSET', 'dh:contacts', c.id, JSON.stringify(c)]);
    return C.send(res, 200, { ok: true, contact: c });
  }
  if (body.action === 'contact-note') {
    const text = str(body.text, 2000).trim();
    if (!text) throw new C.PortalError(400, 'Write a note first.');
    const c = await getJson('dh:contacts', str(body.id, 40));
    if (!c) throw new C.PortalError(404, 'This contact was removed.');
    c.notes = (c.notes || []).concat([{ by: user.name, at: now, text }]).slice(-100);
    c.updatedBy = user.name; c.updatedAt = now;
    await C.redis(['HSET', 'dh:contacts', c.id, JSON.stringify(c)]);
    return C.send(res, 200, { ok: true, contact: c });
  }
  if (body.action === 'contact-delete') {
    await C.redis(['HDEL', 'dh:contacts', str(body.id, 40)]);
    return C.send(res, 200, { ok: true });
  }

  if (body.action === 'settings') {
    const s = body.settings || {}, out = {};
    Object.keys(C.DEFAULT_SETTINGS).forEach((k) => {
      out[k] = Array.isArray(s[k]) ? s[k].map((x) => str(x, 80).trim()).filter(Boolean).slice(0, 300) : C.DEFAULT_SETTINGS[k];
    });
    await C.redis(['SET', 'dh:settings', JSON.stringify(out)]);
    return C.send(res, 200, { ok: true, settings: out });
  }

  if (body.action === 'reset-settings') {
    await C.redis(['DEL', 'dh:settings']);
    return C.send(res, 200, { ok: true, settings: C.DEFAULT_SETTINGS });
  }

  throw new C.PortalError(400, 'Invalid request.');
});
