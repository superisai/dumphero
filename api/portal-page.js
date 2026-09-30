// Serves /portal: the sign-in screen, or the portal app once signed in.
const C = require('./_lib/core');
const PAGES = require('./_lib/pages');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let user = null, setupError = '';
  try { user = C.currentUser(req); } catch (e) { setupError = e.message; }
  if (!user) {
    let html = PAGES.login;
    if (setupError || !Object.keys(C.loadUsers()).length) {
      const msg = setupError || 'The portal is not set up yet (no users have been added in Vercel).';
      html = html.replace('<div class="err" id="err" role="alert"></div>', '<div class="err show" id="err" role="alert">' + msg.replace(/[<>&]/g, '') + '</div>');
    }
    res.statusCode = 200; return res.end(html);
  }
  const boot = JSON.stringify({ user: user.name, users: C.userNames() }).replace(/</g, '\\u003c');
  res.statusCode = 200;
  res.end(PAGES.app.replace('/*__BOOT__*/null', boot));
};
