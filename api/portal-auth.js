// Sign in / sign out for the Dump Hero team portal.
const C = require('./_lib/core');

module.exports = C.handle(async (req, res) => {
  if (req.method === 'GET') {
    const u = C.currentUser(req);
    if (!u) return C.send(res, 401, { ok: false });
    return C.send(res, 200, { ok: true, user: u.name, users: C.userNames() });
  }
  C.requirePost(req);
  const body = await C.readBody(req);

  if (body.action === 'logout') return C.send(res, 200, { ok: true }, { 'Set-Cookie': C.clearCookie() });

  if (body.action !== 'login') throw new C.PortalError(400, 'Invalid request.');
  const username = String(body.username || '').trim().slice(0, 80);
  const password = String(body.password || '').slice(0, 200);
  const ip = C.clientIp(req);

  // Slow down password guessing (only when shared storage is connected).
  const ipKey = 'dh:rl:ip:' + ip, userKey = 'dh:rl:user:' + username.toLowerCase();
  if (C.hasStorage()) {
    const [ipCount, userCount] = await Promise.all([C.redis(['INCR', ipKey]), C.redis(['INCR', userKey])]);
    if (ipCount === 1) await C.redis(['EXPIRE', ipKey, 900]);
    if (userCount === 1) await C.redis(['EXPIRE', userKey, 900]);
    if (ipCount > 25 || userCount > 8) throw new C.PortalError(429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
  }

  const user = C.loadUsers()[username.toLowerCase()];
  const ok = C.verifyPassword(password, user ? user.hash : C.DUMMY) && !!user;
  if (!ok) throw new C.PortalError(401, 'That username or password is not correct.');

  if (C.hasStorage()) await C.redis(['DEL', userKey]);
  C.send(res, 200, { ok: true, user: user.name }, { 'Set-Cookie': C.sessionCookie(C.makeToken(user)) });
});
