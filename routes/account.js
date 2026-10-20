const config = require('../lib/config');
const D = require('../lib/db');
const { endSessionsForUser } = require('../lib/app');
const P = require('../lib/profiles');
const { walletOf } = require('../lib/payments');
const { HttpError } = require('../lib/app');
const { html, naira, fmtDate, fmtDateTime, str, truncate, searchTokens } = require('../lib/util');
const { layout, csrf, stoneCard, shareLinks, icon } = require('../views/layout');
const { requireAuth } = require('./auth');
const { ownMemorial } = require('./memorials');

const STATUS = {
  awaiting_payment: ['Awaiting payment', 'warn'],
  pending_review: ['In review', 'info'],
  approved: ['Live', 'ok'],
  rejected: ['Needs changes', 'error'],
  suspended: ['Suspended', 'error'],
};
const statusChip = (s) => html`<span class="chip chip--${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const MIN_WITHDRAWAL = 1000;

function accountNav(active) {
  const items = [['/account', 'Overview'], ['/account/earnings', 'Earnings'], ['/account/tributes', 'My tributes'], ['/account/flowers', 'My flowers'], ['/account/settings', 'Settings']];
  return html`<nav class="tabs" aria-label="Account">${items.map(([href, label]) => html`<a href="${href}" ${active === href ? html`aria-current="page"` : ''}>${label}</a>`)}</nav>`;
}

function register(app) {
  app.get('/account', requireAuth, async (req, res) => {
    const mine = (await D.find(D.col('profiles').where('creator_id', '==', req.user.id).orderBy('created_at', 'desc').limit(200))).map(P.decorate);
    const w = walletOf(req.user);
    const tribCount = req.user.tribute_count || 0;
    res.html(layout(req, {
      title: 'My account',
      body: html`<section class="page">
        <header class="page__head"><h1>Hello, ${req.user.full_name.split(' ')[0]}</h1>${accountNav('/account')}</header>
        <div class="stats">
          <div class="stat"><span class="stat__n">${mine.length}</span><span class="stat__l">Memorials created</span></div>
          <div class="stat"><span class="stat__n">${naira(w.earned)}</span><span class="stat__l">Earned from tributes</span></div>
          <div class="stat"><span class="stat__n">${naira(w.available)}</span><span class="stat__l">Available to withdraw</span></div>
          <div class="stat"><span class="stat__n">${tribCount}</span><span class="stat__l">Tributes you have left</span></div>
        </div>
        <div class="section-head"><h2>Your memorials</h2><a class="btn btn--brass btn--sm" href="/create">Create a memorial</a></div>
        ${mine.length ? html`<div class="mem-list">${mine.map((p) => html`<a class="mem-row" href="/account/memorials/${p.id}">
            <img src="${p.photoUrl}" alt="">
            <span class="mem-row__main"><strong>${p.name}</strong><span class="muted">${p.years} · ${p.cat.name}</span></span>
            ${statusChip(p.status)}
          </a>`)}</div>`
        : html`<div class="empty"><p>You haven’t created a memorial yet.</p><a class="btn btn--ink" href="/create">Create the first one</a></div>`}
      </section>`,
    }));
  });

  app.get('/account/memorials/:id', requireAuth, async (req, res) => {
    const p = await ownMemorial(req);
    const w = P.editWindow(p);
    const [rev, tributeRows] = await Promise.all([
      P.pendingRevision(p.id),
      D.find(D.col('tributes').where('profile_id', '==', p.id).where('status', 'in', ['published', 'hidden']).orderBy('paid_at', 'desc').limit(300)),
    ]);
    const lastRev = p.last_revision;
    const tributes = tributeRows.map((t) => ({ ...t, full_name: t.user_name }));
    const earned = p.creator_earned || 0;
    const charity = p.charity_raised || 0;
    const upgrades = ['vip', 'vvip'].filter((c) => p.category !== 'legend' && config.categories[c].rank > p.cat.rank);
    const url = `${config.baseUrl}${p.url}`;

    let editNote;
    if (p.status !== 'approved') editNote = 'You can change the details until the memorial is published.';
    else if (rev) editNote = 'Your last changes are being reviewed. You will be able to edit again after that.';
    else if (w.allowed) editNote = w.first ? 'Your first edit can be made at any time. After that, each edit opens 90 days after the last one.' : 'An edit is available now.';
    else editNote = `Your next edit opens on ${fmtDate(w.nextAt.slice(0, 10))}.`;

    res.html(layout(req, {
      title: `Memorial for ${p.plain}`,
      body: html`<section class="page">
        <p class="crumb"><a href="/account">My account</a></p>
        <div class="manage">
          <div class="manage__stone">${stoneCard(p)}</div>
          <div class="manage__main">
            <div class="manage__title"><h1>${p.name}</h1>${statusChip(p.status)}</div>
            <p class="muted">${p.cat.name} memorial · created ${fmtDate(p.created_at.slice(0, 10))}</p>

            ${p.status === 'awaiting_payment' ? html`<div class="callout callout--warn">
              <p>The listing fee of <strong>${naira(D.prices(p.category).listingFee)}</strong> hasn’t been paid yet. The memorial goes to review once it is paid.</p>
              <form method="post" action="/account/memorials/${p.id}/pay">${csrf(req)}<button class="btn btn--brass">Pay ${naira(D.prices(p.category).listingFee)}</button></form></div>` : ''}
            ${p.status === 'pending_review' ? html`<div class="callout callout--info"><p>Our team is checking the documents. Most memorials are reviewed within 24 hours. We’ll call ${p.uploader_phone || 'you'} if anything is unclear.</p></div>` : ''}
            ${p.status === 'rejected' ? html`<div class="callout callout--error"><p><strong>What needs to change:</strong> ${p.reject_reason || 'Contact support for details.'}</p><p>Edit the memorial to fix this, and it goes straight back to review.</p></div>` : ''}
            ${p.status === 'suspended' ? html`<div class="callout callout--error"><p>This memorial has been suspended. ${p.reject_reason || ''} Contact support@tillwemeet.com.</p></div>` : ''}
            ${lastRev && lastRev.status === 'rejected' && !rev ? html`<div class="callout callout--error"><p>Your changes from ${fmtDate(lastRev.created_at.slice(0, 10))} weren’t accepted: ${lastRev.admin_note || 'no reason given'}. Your edit allowance was returned.</p></div>` : ''}

            <div class="stats stats--sm">
              <div class="stat"><span class="stat__n">${tributes.filter((t) => t.status === 'published').length}</span><span class="stat__l">Tributes</span></div>
              <div class="stat"><span class="stat__n">${p.flower_count}</span><span class="stat__l">Flowers</span></div>
              <div class="stat"><span class="stat__n">${naira(earned)}</span><span class="stat__l">Your 40% share</span></div>
              <div class="stat"><span class="stat__n">${naira(charity)}</span><span class="stat__l">Raised for charity</span></div>
              <div class="stat"><span class="stat__n">${p.views}</span><span class="stat__l">Visits</span></div>
            </div>

            <div class="actions">
              ${p.status === 'approved' ? html`<a class="btn btn--ink" href="${p.url}">View memorial</a>` : ''}
              ${(p.status !== 'approved' || (w.allowed && !rev)) && p.status !== 'suspended' ? html`<a class="btn btn--ghost" href="/account/memorials/${p.id}/edit">Edit memorial</a>` : html`<button class="btn btn--ghost" disabled>Edit memorial</button>`}
            </div>
            <p class="muted small">${editNote}</p>

            ${upgrades.length && p.status !== 'suspended' ? html`<div class="upgrade">
              <h2 class="h-sub">Upgrade the memorial</h2>
              <div class="upgrade__opts">${upgrades.map((c) => {
                const diff = p.status === 'awaiting_payment' ? D.prices(c).listingFee : D.prices(c).listingFee - D.prices(p.category).listingFee;
                return html`<form method="post" action="/account/memorials/${p.id}/upgrade" class="upgrade__opt">${csrf(req)}
                  <input type="hidden" name="to" value="${c}">
                  <p><strong>${config.categories[c].name}</strong> for ${naira(diff)}${p.status === 'awaiting_payment' ? '' : ' more'}</p>
                  <p class="muted small">${c === 'vip' ? 'Adds a tone, a 6-photo gallery, candles and the marble finish.' : 'Adds a video, timeline, order of service, a 12-photo gallery and the homepage spotlight.'}</p>
                  <button class="btn btn--ghost btn--sm">Upgrade to ${config.categories[c].name}</button></form>`;
              })}</div></div>` : ''}

            ${p.status === 'approved' ? html`<h2 class="h-sub">Share the memorial</h2>${shareLinks(url, `In loving memory of ${p.name} (${p.years}). Visit the memorial and leave a tribute on tillwemeet:`)}` : ''}

            <h2 class="h-sub">Tributes</h2>
            ${tributes.length ? html`<ul class="trib-admin">${tributes.map((t) => html`<li>
              <p><strong>${t.full_name}</strong>${t.relationship ? html` · ${t.relationship}` : ''} <span class="muted small">${fmtDateTime(t.paid_at)}</span> ${t.status === 'hidden' ? html`<span class="chip chip--error">Hidden</span>` : ''}</p>
              <p>${truncate(t.message, 240)}</p>
              ${t.status === 'published' ? html`<form method="post" action="/tributes/${t.id}/report" class="inline">${csrf(req)}
                <input type="hidden" name="reason" value="Reported by memorial creator"><button class="linklike small">Report this tribute</button></form>` : ''}
            </li>`)}</ul>` : html`<p class="muted">No tributes yet. Share the memorial so friends and family can leave one.</p>`}
          </div>
        </div>
      </section>`,
    }));
  });

  app.get('/account/earnings', requireAuth, async (req, res) => {
    const w = walletOf(req.user);
    const [ledger, wd] = await Promise.all([
      D.find(D.col('ledger').where('account', '==', 'creator').where('user_id', '==', req.user.id).orderBy('created_at', 'desc').limit(100)),
      D.find(D.col('withdrawals').where('user_id', '==', req.user.id).orderBy('created_at', 'desc').limit(100)),
    ]);
    const rows = ledger.map((l) => ({ ...l, slug: l.memorial_slug, first_name: l.memorial_name || '', last_name: '' }));
    const u = req.user;
    res.html(layout(req, {
      title: 'Earnings',
      body: html`<section class="page">
        <header class="page__head"><h1>Earnings</h1>${accountNav('/account/earnings')}</header>
        <p class="lede">You receive 40% of every tribute and flower paid for on memorials you created. Another 40% goes to our charity partners and 20% keeps tillwemeet running.</p>
        <div class="stats">
          <div class="stat"><span class="stat__n">${naira(w.earned)}</span><span class="stat__l">Total earned</span></div>
          <div class="stat"><span class="stat__n">${naira(w.available)}</span><span class="stat__l">Available</span></div>
          <div class="stat"><span class="stat__n">${naira(w.pending)}</span><span class="stat__l">Being paid out</span></div>
          <div class="stat"><span class="stat__n">${naira(w.paidOut)}</span><span class="stat__l">Paid to your bank</span></div>
        </div>
        <div class="two-col">
          <form class="card form" method="post" action="/account/withdraw">${csrf(req)}
            <h2 class="h-sub">Withdraw to your bank</h2>
            ${u.account_number ? html`<p class="muted small">Paid to ${u.account_name}, ${u.bank_name} ${u.account_number}. <a href="/account/settings">Change</a></p>
              <label class="field"><span>Amount (₦)</span><input type="number" name="amount" min="${MIN_WITHDRAWAL}" max="${Math.floor(w.available)}" step="1" required value="${Math.floor(w.available)}"><small>Minimum ${naira(MIN_WITHDRAWAL)}. Paid within 3 working days.</small></label>
              <button class="btn btn--ink" ${w.available < MIN_WITHDRAWAL ? 'disabled' : ''}>Request withdrawal</button>`
            : html`<p>Add your bank details in <a href="/account/settings">Settings</a> before you withdraw.</p>`}
          </form>
          <div>
            <h2 class="h-sub">Withdrawals</h2>
            ${wd.length ? html`<table class="table"><thead><tr><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>
              ${wd.map((x) => html`<tr><td>${fmtDate(x.created_at.slice(0, 10))}</td><td>${naira(x.amount)}</td><td>${x.status}${x.admin_note ? html`<br><small class="muted">${x.admin_note}</small>` : ''}</td></tr>`)}</tbody></table>`
            : html`<p class="muted">No withdrawals yet.</p>`}
          </div>
        </div>
        <h2 class="h-sub">Earnings by memorial</h2>
        ${rows.length ? html`<table class="table"><thead><tr><th>Date</th><th>Memorial</th><th>From</th><th>Your share</th></tr></thead><tbody>
          ${rows.map((r) => html`<tr><td>${fmtDateTime(r.created_at)}</td><td><a href="/m/${r.slug}">${r.first_name} ${r.last_name}</a></td><td>${r.flower_id ? 'Flower' : 'Tribute'}</td><td>${naira(r.amount)}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">Earnings appear here when someone pays for a tribute or lays a flower on one of your memorials.</p>`}
      </section>`,
    }));
  });

  app.post('/account/withdraw', requireAuth, async (req, res) => {
    const amount = Math.floor(Number(req.body.amount));
    const u = req.user;
    if (!u.account_number) throw new HttpError(400, 'Add your bank details first.');
    // Checked and recorded in one transaction, so two requests can't overdraw the balance.
    const userRef = D.col('users').doc(u.id);
    await D.db.runTransaction(async (tx) => {
      const w = walletOf(D.fromSnap(await tx.get(userRef)));
      if (!(amount >= MIN_WITHDRAWAL) || amount > w.available) throw new HttpError(400, `Enter an amount between ${naira(MIN_WITHDRAWAL)} and ${naira(w.available)}.`);
      tx.create(D.col('withdrawals').doc(), {
        user_id: u.id, user_name: u.full_name, user_email: u.email, amount, bank_name: u.bank_name, account_number: u.account_number, account_name: u.account_name,
        status: 'pending', admin_note: null, created_at: D.now(), processed_at: null,
      });
      tx.update(userRef, { withdrawn: D.inc(amount) });
    });
    await D.audit(u, 'withdrawal.request', `user:${u.id}`, amount);
    req.flash('ok', `Withdrawal of ${naira(amount)} requested. It will reach your bank within 3 working days.`);
    res.redirect('/account/earnings');
  });

  app.get('/account/tributes', requireAuth, async (req, res) => {
    const rows = (await D.find(D.col('tributes').where('user_id', '==', req.user.id).orderBy('created_at', 'desc').limit(200))).map((t) => ({ ...t, ...t.profile, id: t.id }));
    res.html(layout(req, {
      title: 'My tributes',
      body: html`<section class="page">
        <header class="page__head"><h1>My tributes</h1>${accountNav('/account/tributes')}</header>
        ${rows.length ? html`<ul class="trib-admin">${rows.map((t) => html`<li>
          <p><a href="/m/${t.slug}"><strong>${t.titles ? t.titles.replace(/,/g, '') + ' ' : ''}${t.first_name} ${t.last_name}</strong></a>
            ${t.status === 'published' ? html`<span class="chip chip--ok">Published</span>` : t.status === 'hidden' ? html`<span class="chip chip--error">Hidden by moderators</span>` : html`<span class="chip chip--warn">Not paid</span>`}</p>
          <p>${truncate(t.message, 300)}</p>
          ${t.status === 'published' ? html`<a class="small" href="/t/${t.id}">Share this tribute</a>` : t.status === 'pending_payment' ? html`<a class="small" href="/m/${t.slug}#tribute-form">Finish paying</a>` : ''}
        </li>`)}</ul>` : html`<div class="empty"><p>You haven’t left a tribute yet.</p><a class="btn btn--ink" href="/memorials">Browse memorials</a></div>`}
      </section>`,
    }));
  });

  app.get('/account/flowers', requireAuth, async (req, res) => {
    const FL = require('../lib/flowers');
    const rows = (await D.find(D.col('flowers').where('user_id', '==', req.user.id).where('status', 'in', ['published', 'hidden']).orderBy('paid_at', 'desc').limit(200))).map((f) => ({ ...f, ...f.profile, id: f.id }));
    res.html(layout(req, {
      title: 'My flowers',
      body: html`<section class="page">
        <header class="page__head"><h1>My flowers</h1>${accountNav('/account/flowers')}</header>
        ${rows.length ? html`<ul class="trib-admin">${rows.map((f) => html`<li>
          <p><strong>${(FL.FLOWERS[f.flower] || {}).name}</strong> for <a href="/m/${f.slug}">${f.first_name} ${f.last_name}</a> <span class="muted small">${fmtDateTime(f.paid_at)}</span>
            ${f.status === 'hidden' ? html`<span class="chip chip--error">Hidden by moderators</span>` : ''}</p>
          ${f.note ? html`<p>${truncate(f.note, 200)}</p>` : ''}
          <a class="small" href="/f/${f.id}">Download or share the card</a>
        </li>`)}</ul>` : html`<div class="empty"><p>You haven’t laid a flower yet.</p><a class="btn btn--ink" href="/memorials">Browse memorials</a></div>`}
      </section>`,
    }));
  });

  app.get('/account/settings', requireAuth, (req, res) => {
    const u = req.user;
    res.html(layout(req, {
      title: 'Settings',
      body: html`<section class="page">
        <header class="page__head"><h1>Settings</h1>${accountNav('/account/settings')}</header>
        <div class="two-col">
          <form class="card form" method="post" action="/account/settings">${csrf(req)}
            <h2 class="h-sub">Your details</h2>
            <label class="field"><span>Full name</span><input name="full_name" required maxlength="120" value="${u.full_name}"></label>
            <label class="field"><span>Phone number</span><input name="phone" required maxlength="20" value="${u.phone || ''}"></label>
            <label class="field"><span>Email</span><input value="${u.email}" disabled></label>
            <h2 class="h-sub">Bank account for withdrawals</h2>
            <label class="field"><span>Bank</span><input name="bank_name" maxlength="80" value="${u.bank_name || ''}" placeholder="e.g. Access Bank"></label>
            <label class="field"><span>Account number</span><input name="account_number" maxlength="10" pattern="[0-9]{10}" inputmode="numeric" value="${u.account_number || ''}"><small>Your 10-digit NUBAN.</small></label>
            <label class="field"><span>Account name</span><input name="account_name" maxlength="120" value="${u.account_name || ''}"></label>
            <button class="btn btn--ink">Save settings</button>
          </form>
          <form class="card form" method="post" action="/account/password">${csrf(req)}
            <h2 class="h-sub">Change password</h2>
            <label class="field"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
            <label class="field"><span>New password</span><input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
            <button class="btn btn--ghost">Change password</button>
          </form>
        </div>
      </section>`,
    }));
  });

  app.post('/account/settings', requireAuth, async (req, res) => {
    const b = req.body;
    const acct = str(b.account_number, 10);
    if (acct && !/^\d{10}$/.test(acct)) throw new HttpError(400, 'An account number has 10 digits.');
    const fullName = str(b.full_name, 120) || req.user.full_name; const phone = str(b.phone, 20);
    await D.col('users').doc(req.user.id).update({
      full_name: fullName, phone, bank_name: str(b.bank_name, 80) || null, account_number: acct || null, account_name: str(b.account_name, 120) || null,
      searchTokens: searchTokens(fullName, req.user.email, phone),
    });
    req.flash('ok', 'Settings saved.');
    res.redirect('/account/settings');
  });

  app.post('/account/password', requireAuth, async (req, res) => {
    const { verifyPassword, hashPassword } = require('../lib/util');
    const row = await D.getDoc('users', req.user.id);
    if (!verifyPassword(String(req.body.current || ''), row.password_hash)) throw new HttpError(400, 'Your current password is incorrect.');
    if (String(req.body.password || '').length < 8) throw new HttpError(400, 'Your new password needs at least 8 characters.');
    await D.col('users').doc(req.user.id).update({ password_hash: hashPassword(req.body.password) });
    await endSessionsForUser(req.user.id, req._session.id);
    req.flash('ok', 'Password changed. Other devices have been signed out.');
    res.redirect('/account/settings');
  });
}

module.exports = { register, statusChip, STATUS };
