// A small, dependency-free web framework: routing, sessions, CSRF, body parsing, static files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const config = require('./config');
const db = require('./db');
const storage = require('./storage');
const { parseCookies, parseMultipart, token } = require('./util');

const SESSION_COOKIE = 'twm_sid';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- Sessions (stored in Firestore, collection "sessions") ----------
// A session is only written when its contents change, so ordinary page views cost one read.
async function loadSession(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    const row = await db.getDoc('sessions', sid);
    if (row && row.expires > Date.now()) return { id: sid, data: row.data || {}, isNew: false, saved: JSON.stringify(row.data || {}), expires: row.expires };
  }
  return { id: token(32), data: {}, isNew: true, saved: '{}' };
}
async function saveSession(res, s) {
  if (s.destroyed) {
    await db.col('sessions').doc(s.id).delete().catch(() => {});
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return;
  }
  const json = JSON.stringify(s.data);
  if (s.isNew && json === '{}') return; // don't persist empty anonymous sessions
  const refreshDue = !s.expires || s.expires - Date.now() < SESSION_TTL / 2;
  if (json !== s.saved || s.isNew || refreshDue) {
    const expires = Date.now() + SESSION_TTL;
    await db.col('sessions').doc(s.id).set({ data: s.data, uid: s.data.uid || null, expires, expires_at: new Date(expires) });
  }
  const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
  res.appendHeader('Set-Cookie', `${SESSION_COOKIE}=${s.id}; Path=/; Max-Age=${SESSION_TTL / 1000}; HttpOnly; SameSite=Lax${secure}`);
}
// Rotate session id on login to prevent fixation
async function regenerateSession(req) {
  const old = req._session.id;
  req._session.id = token(32);
  req._session.isNew = true;
  await db.col('sessions').doc(old).delete().catch(() => {});
}
/** Signs a user out everywhere (used after password changes, bans and resets). */
async function endSessionsForUser(uid, exceptId) {
  const rows = await db.find(db.col('sessions').where('uid', '==', uid));
  const batch = db.db.batch();
  rows.filter((r) => r.id !== exceptId).forEach((r) => batch.delete(db.col('sessions').doc(r.id)));
  await batch.commit();
}
// Remove expired sessions every hour. (You can also set a Firestore TTL policy on sessions.expires_at.)
setInterval(async () => {
  try {
    const old = await db.find(db.col('sessions').where('expires', '<', Date.now()).limit(400));
    const batch = db.db.batch(); old.forEach((r) => batch.delete(db.col('sessions').doc(r.id))); await batch.commit();
  } catch (e) { console.error('session cleanup', e.message); }
}, 3600000).unref();

// ---------- Simple in-memory rate limiter ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n++; buckets.set(key, b);
  if (b.n > max) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

// ---------- Body ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `Upload too large. The limit is ${Math.round(limit / 1048576)}MB in total.`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- Router ----------
function createApp() {
  const routes = [];
  const add = (method, pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handlers });
  };
  const app = {
    get: (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    errorPage: null, notFoundPage: null, layoutHook: null,
    csrfExempt: new Set(),
  };

  app.handle = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    req.path = decodeURIComponent(url.pathname);
    req.query = Object.fromEntries(url.searchParams);
    req.body = {}; req.files = {};

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; script-src 'self' https://js.paystack.co; frame-src https://checkout.paystack.com; connect-src 'self'; form-action 'self' https://checkout.paystack.com; base-uri 'self'");
    if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    try {
      // Static assets
      if (req.method === 'GET' && req.path.startsWith('/static/')) {
        const base = path.join(config.ROOT, 'public');
        return serveFile(req, res, path.join(base, req.path.slice('/static/'.length)), base, 3600);
      }
      if (req.method === 'GET' && req.path.startsWith('/media/')) {
        const name = req.path.slice('/media/'.length);
        if (!/^[A-Za-z0-9_.-]+$/.test(name) || !(await storage.serve(req, res, 'public', name, 86400))) throw new HttpError(404, 'Not found');
        return;
      }

      req._session = await loadSession(req);
      req.session = req._session.data;
      req.ip_ = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

      // Responses save the session first. Handlers may return or await these.
      const send = (status, headers, body) => {
        res._sending = true;
        res._pending = saveSession(res, req._session).catch((e) => console.error('session save', e.message))
          .then(() => { res.writeHead(status, headers); res.end(body); });
        return res._pending;
      };
      res.html = (body, status = 200) => send(status, { 'Content-Type': 'text/html; charset=utf-8' }, String(body));
      res.json = (obj, status = 200) => send(status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));
      res.redirect = (loc) => send(303, { Location: loc }, '');
      req.flash = (type, msg) => { (req.session.flash = req.session.flash || []).push({ type, msg }); };
      req.regenerate = () => regenerateSession(req);
      req.destroySession = () => { req._session.destroyed = true; };
      req.rateLimit = (name, max, windowMs) => rateLimit(`${name}:${req.ip_}`, max, windowMs);

      if (!req.session.csrf) req.session.csrf = token(16);

      const route = routes.find((r) => r.method === req.method && r.re.test(req.path));
      if (!route) throw new HttpError(404, 'Page not found');
      const m = req.path.match(route.re);
      req.params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]));

      if (req.method === 'POST') {
        const ctype = req.headers['content-type'] || '';
        const limit = ctype.startsWith('multipart/') ? config.maxUploadMB * 1048576 : 1048576;
        const buf = await readBody(req, limit);
        req.rawBody = buf;
        if (ctype.startsWith('multipart/form-data')) { const mp = parseMultipart(buf, ctype); req.body = mp.fields; req.files = mp.files; }
        else if (ctype.startsWith('application/x-www-form-urlencoded')) req.body = Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
        else if (ctype.startsWith('application/json')) { try { req.body = JSON.parse(buf.toString('utf8') || '{}'); } catch { req.body = {}; } }
        if (req.files === undefined) req.files = {};
        if (!app.csrfExempt.has(req.path) && req.body._csrf !== req.session.csrf) throw new HttpError(403, 'Your session expired. Go back, refresh the page and try again.');
      }

      for (const h of route.handlers) {
        let nextCalled = false;
        await h(req, res, () => { nextCalled = true; });
        if (!nextCalled || res._sending || res.headersSent) break;
      }
      if (res._pending) await res._pending;
      if (!res._sending && !res.headersSent) throw new HttpError(500, 'No response');
    } catch (err) {
      if (!err.status || err.status >= 500) console.error(err);
      if (res.headersSent || res._sending) { if (res._pending) await res._pending.catch(() => {}); return res.writableEnded || res.end(); }
      const status = err.status || 500;
      const msg = status >= 500 && config.isProd ? 'Something went wrong on our side. Try again in a moment.' : err.message;
      if (req.session && app.errorPage) {
        try { return await res.html(await app.errorPage(req, status, msg), status); } catch (e) { console.error(e); }
      }
      res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(msg);
    }
  };
  return app;
}

function serveFile(req, res, file, base, maxAge) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new HttpError(404, 'Not found');
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new HttpError(404, 'Not found'); }
  if (!stat.isFile()) throw new HttpError(404, 'Not found');
  const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': `public, max-age=${maxAge}`, 'Accept-Ranges': 'bytes' };
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(resolved, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(resolved).pipe(res);
}

function listen(app, port) {
  const server = http.createServer((req, res) => app.handle(req, res));
  server.requestTimeout = 5 * 60 * 1000;
  return new Promise((r) => server.listen(port, () => r(server)));
}

module.exports = { createApp, listen, HttpError, serveFile, MIME, endSessionsForUser };
