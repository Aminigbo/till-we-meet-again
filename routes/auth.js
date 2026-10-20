const D = require('../lib/db');
const { createUser, findByEmail, EmailTaken } = require('../lib/users');
const { html, hashPassword, verifyPassword, str, nowISO } = require('../lib/util');
const { layout, csrf } = require('../views/layout');

async function loadUser(req, res, next) {
  if (req.session.uid && req.user === undefined) {
    const u = await D.getDoc('users', req.session.uid);
    if (u && u.status === 'active') { delete u.password_hash; req.user = u; } else delete req.session.uid;
  }
  if (next) next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  req.flash('info', 'Sign in to continue.');
  res.redirect(`/login?next=${encodeURIComponent(req.path + (req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''))}`);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) return requireAuth(req, res, next);
  const { HttpError } = require('../lib/app');
  throw new HttpError(403, 'This area is for tillwemeet administrators.');
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/account');

function authPage(req, { mode, values = {}, error }) {
  const isLogin = mode === 'login';
  const next = req.query.next || values.next || '';
  return layout(req, {
    title: isLogin ? 'Sign in' : 'Create your account',
    bodyClass: 'page-auth',
    body: html`<section class="auth">
      <div class="auth__aside">
        <h1>${isLogin ? 'Welcome back' : 'Create your account'}</h1>
        <p>${isLogin
          ? 'Sign in to read life stories, leave a tribute, or manage the memorials you created.'
          : 'An account lets you leave tributes, read full life stories and create memorials for the people you have lost.'}</p>
      </div>
      <form class="card form auth__form" method="post" action="/${mode}${next ? `?next=${encodeURIComponent(next)}` : ''}">
        ${csrf(req)}
        <input type="hidden" name="next" value="${next}">
        ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
        ${!isLogin ? html`
          <label class="field"><span>Full name</span><input name="full_name" required maxlength="120" autocomplete="name" value="${values.full_name || ''}"></label>
          <label class="field"><span>Phone number</span><input name="phone" required maxlength="20" autocomplete="tel" inputmode="tel" placeholder="0803 000 0000" value="${values.phone || ''}"></label>` : ''}
        <label class="field"><span>Email address</span><input type="email" name="email" required maxlength="160" autocomplete="email" value="${values.email || ''}"></label>
        <label class="field"><span>Password</span><input type="password" name="password" required minlength="${isLogin ? 1 : 8}" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
          ${!isLogin ? html`<small>At least 8 characters.</small>` : ''}</label>
        ${!isLogin ? html`
          <label class="field"><span>Confirm password</span><input type="password" name="password2" required minlength="8" autocomplete="new-password"></label>
          <label class="check"><input type="checkbox" name="terms" value="1" required> <span>I agree to the <a href="/terms" target="_blank">terms and privacy policy</a>.</span></label>` : ''}
        <button class="btn btn--ink btn--block">${isLogin ? 'Sign in' : 'Create account'}</button>
        <p class="muted center">${isLogin
          ? html`New to tillwemeet? <a href="/register${next ? `?next=${encodeURIComponent(next)}` : ''}">Create an account</a>`
          : html`Already have an account? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">Sign in</a>`}</p>
      </form>
    </section>`,
  });
}

function register(app) {
  app.get('/login', (req, res) => (req.user ? res.redirect(safeNext(req.query.next)) : res.html(authPage(req, { mode: 'login' }))));
  app.get('/register', (req, res) => (req.user ? res.redirect('/account') : res.html(authPage(req, { mode: 'register' }))));

  app.post('/login', async (req, res) => {
    req.rateLimit('login', 10, 10 * 60 * 1000);
    const email = str(req.body.email, 160).toLowerCase();
    const u = await findByEmail(email);
    if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
      return res.html(authPage(req, { mode: 'login', values: req.body, error: 'That email and password don’t match an account. Check them and try again.' }), 401);
    }
    if (u.status !== 'active') return res.html(authPage(req, { mode: 'login', values: req.body, error: 'This account has been suspended. Contact support@tillwemeet.com.' }), 403);
    await req.regenerate();
    req.session.uid = u.id;
    await D.col('users').doc(u.id).update({ last_login_at: nowISO() });
    req.flash('ok', `Welcome back, ${u.full_name.split(' ')[0]}.`);
    res.redirect(safeNext(req.body.next));
  });

  app.post('/register', async (req, res) => {
    req.rateLimit('register', 8, 60 * 60 * 1000);
    const v = { full_name: str(req.body.full_name, 120), email: str(req.body.email, 160).toLowerCase(), phone: str(req.body.phone, 20), next: req.body.next };
    const pw = String(req.body.password || '');
    let error = null;
    if (v.full_name.length < 3) error = 'Enter your full name.';
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) error = 'Enter a valid email address.';
    else if (!/^\+?[0-9 ()-]{7,20}$/.test(v.phone)) error = 'Enter a valid phone number.';
    else if (pw.length < 8) error = 'Your password needs at least 8 characters.';
    else if (pw !== req.body.password2) error = 'The two passwords don’t match.';
    else if (!req.body.terms) error = 'Accept the terms to create an account.';
    if (error) return res.html(authPage(req, { mode: 'register', values: v, error }), 400);
    let uid;
    try { uid = await createUser({ email: v.email, password: pw, full_name: v.full_name, phone: v.phone }); } catch (e) {
      if (e instanceof EmailTaken) return res.html(authPage(req, { mode: 'register', values: v, error: 'An account with this email already exists. Sign in instead.' }), 400);
      throw e;
    }
    await req.regenerate();
    req.session.uid = uid;
    req.flash('ok', 'Your account is ready.');
    res.redirect(safeNext(v.next));
  });

  app.post('/logout', (req, res) => { req.destroySession(); res.redirect('/'); });
}

module.exports = { register, loadUser, requireAuth, requireAdmin };
