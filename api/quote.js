// Dump Hero quote request handler (Vercel serverless function).
// Receives the quote form as JSON and emails it, with any photos attached,
// using Resend (https://resend.com).
//
// Required environment variables (set them in Vercel > Settings > Environment Variables):
//   RESEND_API_KEY   your Resend API key (starts with "re_")
//   QUOTE_TO_EMAIL   the email address that should receive quote requests
// Optional:
//   QUOTE_FROM_EMAIL sender address, e.g. "Dump Hero Website <quotes@yourdomain.com>".
//                    Only works after your domain is verified in Resend. Until then the
//                    default Resend test sender is used, which can only email the address
//                    you signed up to Resend with.

const MAX_PHOTOS = 5;
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024; // keeps us under Vercel's 4.5 MB request limit
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.QUOTE_TO_EMAIL;
  const fromEmail = process.env.QUOTE_FROM_EMAIL || 'Dump Hero Website <onboarding@resend.dev>';
  if (!apiKey || !toEmail) {
    console.error('Missing RESEND_API_KEY or QUOTE_TO_EMAIL environment variable');
    return res.status(500).json({ ok: false, error: 'The quote form is not set up yet.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }

  // Honeypot: real people never fill this hidden field; bots often do.
  if (clean(body.company, 200)) {
    return res.status(200).json({ ok: true });
  }

  const name = clean(body.name, 120);
  const phone = clean(body.phone, 40);
  const email = clean(body.email, 200);
  const service = clean(body.service, 120);
  const address = clean(body.address, 300);
  const date = clean(body.date, 40);
  const notes = clean(body.notes, 5000);

  if (!name || !phone) {
    return res.status(400).json({ ok: false, error: 'Please include your name and phone number.' });
  }
  if (email && !validEmail(email)) {
    return res.status(400).json({ ok: false, error: 'Please check your email address.' });
  }

  const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
  const attachments = [];
  let totalBytes = 0;
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i] || {};
    const type = clean(p.type, 40).toLowerCase();
    const data = typeof p.data === 'string' ? p.data.replace(/^data:[^,]*,/, '') : '';
    if (!data || !ALLOWED_TYPES.includes(type) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      return res.status(400).json({ ok: false, error: 'One of the photos could not be read. Please try a JPG or PNG.' });
    }
    totalBytes += Math.floor((data.length * 3) / 4);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return res.status(413).json({ ok: false, error: 'Those photos are too large. Please send fewer photos.' });
    }
    const ext = type.split('/')[1].replace('jpeg', 'jpg');
    const safeName = clean(p.name, 80).replace(/[^\w.\- ]/g, '') || `photo-${i + 1}.${ext}`;
    attachments.push({ filename: safeName, content: data });
  }

  const rows = [
    ['Name', name],
    ['Phone', phone],
    ['Email', email || 'Not provided'],
    ['Service', service || 'Not specified'],
    ['Drop-off address', address || 'Not provided'],
    ['Preferred date', date || 'Not provided'],
    ['Project details', notes || 'None'],
    ['Photos', attachments.length ? `${attachments.length} attached` : 'None'],
  ];

  const text = ['New quote request from the Dump Hero website', '']
    .concat(rows.map(([k, v]) => `${k}: ${v}`))
    .join('\n');

  const phoneDigits = phone.replace(/[^\d+]/g, '');
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#1B1A17">
  <h2 style="margin:0 0 4px;color:#C2410C">New quote request</h2>
  <p style="margin:0 0 16px;color:#57534E">Sent from the Dump Hero website</p>
  <table style="border-collapse:collapse;width:100%;font-size:15px">
    ${rows.map(([k, v]) => `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid #E7E2D8;font-weight:bold;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:8px 0;border-bottom:1px solid #E7E2D8;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`).join('')}
  </table>
  <p style="margin:20px 0 0">
    <a href="tel:${escapeHtml(phoneDigits)}" style="display:inline-block;padding:10px 18px;background:#C2410C;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Call ${escapeHtml(name)}</a>
    <a href="sms:${escapeHtml(phoneDigits)}" style="display:inline-block;padding:10px 18px;margin-left:8px;border:2px solid #C2410C;color:#C2410C;text-decoration:none;border-radius:6px;font-weight:bold">Text ${escapeHtml(name)}</a>
  </p>
</div>`;

  const payload = {
    from: fromEmail,
    to: [toEmail],
    subject: `New quote request: ${service || 'Dump Hero'} from ${name}`,
    text,
    html,
  };
  if (email) payload.reply_to = email;
  if (attachments.length) payload.attachments = attachments;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('Resend error', r.status, detail);
      return res.status(502).json({ ok: false, error: 'We could not send your request right now.' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Send failed', err);
    return res.status(502).json({ ok: false, error: 'We could not send your request right now.' });
  }
};

// Allow photo uploads up to Vercel's request limit.
module.exports.config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
