// Admin dashboard: verification, moderation, money and settings.
const config = require('../lib/config');
const D = require('../lib/db');
const P = require('../lib/profiles');
const storage = require('../lib/storage');
const { HttpError, endSessionsForUser } = require('../lib/app');
const { walletOf } = require('../lib/payments');
const { findByEmail } = require('../lib/users');
const { toneUrl, html, naira, fmtDate, fmtDateTime, str, truncate, decrypt, maskNin, hashPassword, token, nowISO, sniff, queryWords } = require('../lib/util');
const { layout, csrf, pager, icon } = require('../views/layout');
const { paragraphs } = require('../views/memorial');
const { requireAdmin } = require('./auth');
const { changeSet, cleanupReplaced } = require('./memorials');
const { statusChip } = require('./account');

const counts = async () => {
  const [review, edits, reports, withdrawals] = await Promise.all([
    D.count(D.col('profiles').where('status', '==', 'pending_review')),
    D.count(D.col('revisions').where('status', '==', 'pending')),
    D.count(D.col('tributes').where('reported', '==', true)),
    D.count(D.col('withdrawals').where('status', '==', 'pending')),
  ]);
  return { review, edits, reports, withdrawals };
};

async function adminLayout(req, active, title, body, c) {
  c = c || await counts();
  const nav = [
    ['/admin', 'Overview', null], ['/admin/review', 'Review queue', c.review], ['/admin/edits', 'Edit requests', c.edits],
    ['/admin/memorials', 'Memorials', null], ['/admin/tributes', 'Tributes', c.reports], ['/admin/flowers', 'Flowers', null], ['/admin/users', 'Users', null],
    ['/admin/payments', 'Payments', null], ['/admin/withdrawals', 'Withdrawals', c.withdrawals], ['/admin/charity', 'Charity', null],
    ['/admin/tones', 'Tones', null], ['/admin/settings', 'Pricing', null], ['/admin/audit', 'Audit log', null],
  ];
  return layout(req, {
    title: `${title} — Admin`,
    bodyClass: 'page-admin',
    body: html`<div class="admin">
      <nav class="admin__nav" aria-label="Admin">${nav.map(([href, label, n]) => html`<a href="${href}" ${active === href ? 'aria-current="page"' : ''}>${label}${n ? html`<span class="badge">${n}</span>` : ''}</a>`)}</nav>
      <section class="admin__main"><h1>${title}</h1>${body}</section>
    </div>`,
  });
}

const fileLink = (name, label) => {
  if (!name) return html`<span class="muted">Not provided</span>`;
  const isPdf = name.endsWith('.pdf');
  return isPdf ? html`<a class="doc-link" href="/admin/files/${name}" target="_blank" rel="noopener">${icon('file')} Open ${label} (PDF)</a>`
    : html`<a href="/admin/files/${name}" target="_blank" rel="noopener"><img class="doc-img" src="/admin/files/${name}" alt="${label}"></a>`;
};

function kpi(n, l, note) { return html`<div class="stat"><span class="stat__n">${n}</span><span class="stat__l">${l}</span>${note ? html`<span class="stat__note">${note}</span>` : ''}</div>`; }
const pageNo = (req) => Math.min(500, Math.max(1, Number(req.query.page) || 1));
const backTo = (req, fallback) => (req.headers.referer && req.headers.referer.startsWith(config.baseUrl) ? req.headers.referer : fallback);

function register(app) {
  app.get('/admin/files/:name', requireAdmin, async (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new HttpError(404, 'Not found');
    await D.audit(req.user, 'file.view', name);
    if (!(await storage.serve(req, res, 'private', name, 0))) throw new HttpError(404, 'Not found');
  });

  // ---------- Overview ----------
  app.get('/admin', requireAdmin, async (req, res) => {
    const days = []; for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const statusCount = (s) => D.count(D.col('profiles').where('status', '==', s));
    const [c, stats, live, review, unpaid, rejected, byCatList, users, dailyMap, recent] = await Promise.all([
      counts(), D.getStats(), statusCount('approved'), statusCount('pending_review'), statusCount('awaiting_payment'), statusCount('rejected'),
      Promise.all(config.categoryOrder.map((k) => D.count(D.col('profiles').where('status', '==', 'approved').where('category', '==', k)))),
      D.count(D.col('users')), D.getMany('stats_daily', days),
      D.find(D.col('audit_log').orderBy('created_at', 'desc').limit(12)),
    ]);
    const n = (k) => stats[k] || 0;
    const series = days.map((d) => ({ d, s: (dailyMap.get(d) || {}).amount || 0 }));
    const max = Math.max(1, ...series.map((x) => x.s));

    res.html(await adminLayout(req, '/admin', 'Overview', html`
      ${c.review || c.edits || c.reports || c.withdrawals ? html`<div class="todo">
        ${c.review ? html`<a href="/admin/review"><strong>${c.review}</strong> ${c.review === 1 ? 'memorial' : 'memorials'} to verify</a>` : ''}
        ${c.edits ? html`<a href="/admin/edits"><strong>${c.edits}</strong> ${c.edits === 1 ? 'edit request' : 'edit requests'}</a>` : ''}
        ${c.reports ? html`<a href="/admin/tributes?reported=1"><strong>${c.reports}</strong> ${c.reports === 1 ? 'reported tribute' : 'reported tributes'}</a>` : ''}
        ${c.withdrawals ? html`<a href="/admin/withdrawals"><strong>${c.withdrawals}</strong> ${c.withdrawals === 1 ? 'withdrawal' : 'withdrawals'} to pay</a>` : ''}
      </div>` : html`<p class="muted">Nothing is waiting for you.</p>`}
      <h2 class="h-sub">Money</h2>
      <div class="stats">
        ${kpi(naira(n('gross')), 'Total payments received')}
        ${kpi(naira(n('platform_total')), 'Platform revenue', `${naira(n('listings_amount'))} listings, ${naira(n('tributes_amount'))} tributes, ${naira(n('flowers_amount'))} flowers paid`)}
        ${kpi(naira(n('charity_total') - n('charity_given')), 'Charity balance to give', `${naira(n('charity_given'))} given of ${naira(n('charity_total'))}`)}
        ${kpi(naira(n('creator_total') - n('paid_out')), 'Owed to creators', `${naira(n('paid_out'))} paid out`)}
      </div>
      <div class="chart" role="img" aria-label="Payments received per day over the last 30 days">
        <p class="chart__title">Payments received, last 30 days</p>
        <div class="chart__bars">${series.map((x) => html`<span class="chart__bar" style="height:${Math.max(2, Math.round((x.s / max) * 100))}%" title="${fmtDate(x.d)}: ${naira(x.s)}"></span>`)}</div>
        <div class="chart__axis"><span>${fmtDate(series[0].d)}</span><span>Peak ${naira(max === 1 ? 0 : max)}</span><span>Today</span></div>
      </div>
      <h2 class="h-sub">Memorials</h2>
      <div class="stats">${kpi(live, 'Live')}${kpi(review, 'Awaiting review')}${kpi(unpaid, 'Not yet paid')}${kpi(rejected, 'Sent back')}</div>
      <div class="stats stats--sm">
        ${config.categoryOrder.map((k, i) => kpi(byCatList[i], `${config.categories[k].name} live`))}
        ${kpi(users, 'Users')}${kpi(n('tributes_count'), 'Tributes')}${kpi(n('flowers_count'), 'Flowers laid')}
      </div>
      <h2 class="h-sub">Recent activity</h2>
      ${recent.length ? '' : html`<p class="muted">Admin actions such as approvals and payouts appear here.</p>`}
      <table class="table" ${recent.length ? '' : 'hidden'}><tbody>${recent.map((a) => html`<tr><td>${fmtDateTime(a.created_at)}</td><td>${a.actor_name || 'System'}</td><td>${a.action}</td><td>${a.target || ''}</td><td class="muted">${truncate(a.detail || '', 60)}</td></tr>`)}</tbody></table>
    `, c));
  });

  // ---------- Review queue ----------
  app.get('/admin/review', requireAdmin, async (req, res) => {
    const rows = (await D.find(D.col('profiles').where('status', '==', 'pending_review').orderBy('listing_paid_at', 'asc').limit(200))).map(P.decorate);
    res.html(await adminLayout(req, '/admin/review', 'Review queue', rows.length ? html`<p class="muted">Oldest first. Open a memorial to check its documents.</p>
      <table class="table"><thead><tr><th></th><th>Deceased</th><th>Category</th><th>Created by</th><th>Paid</th><th></th></tr></thead><tbody>
      ${rows.map((p) => html`<tr><td><img class="avatar" src="${p.photoUrl}" alt=""></td><td><strong>${p.name}</strong><br><span class="muted small">${p.years}, ${p.state}</span></td>
        <td>${p.cat.name}</td><td>${p.creator_name}<br><span class="muted small">${p.uploader_relationship}</span></td><td>${fmtDateTime(p.listing_paid_at)}</td>
        <td><a class="btn btn--ink btn--sm" href="/admin/memorials/${p.id}">Review</a></td></tr>`)}</tbody></table>`
      : html`<div class="empty"><p>The queue is clear.</p></div>`));
  });

  // ---------- Memorial list ----------
  app.get('/admin/memorials', requireAdmin, async (req, res) => {
    const q = str(req.query.q, 80); const status = str(req.query.status, 20); const cat = str(req.query.category, 10);
    const page = pageNo(req); const per = 40;
    let query = D.col('profiles');
    if (status) query = query.where('status', '==', status);
    if (cat) query = query.where('category', '==', cat);
    let note = '';
    if (q.includes('@')) {
      const u = await findByEmail(q);
      query = query.where('creator_id', '==', u ? u.id : '-');
      note = u ? `Memorials created by ${u.full_name}` : 'No account uses that email.';
    } else if (queryWords(q).length) {
      query = query.where('searchTokens', 'array-contains', queryWords(q)[0]);
    }
    const [total, rowsRaw] = await Promise.all([D.count(query), D.find(query.orderBy('created_at', 'desc').offset((page - 1) * per).limit(per))]);
    const words = queryWords(q.includes('@') ? '' : q);
    const rows = rowsRaw.filter((p) => words.every((w) => (p.searchTokens || []).includes(w))).map(P.decorate);
    res.html(await adminLayout(req, '/admin/memorials', 'Memorials', html`
      <form class="filters">
        <input name="q" value="${q}" placeholder="Name of the deceased, or creator’s email">
        <select name="status"><option value="">Any status</option>${['awaiting_payment', 'pending_review', 'approved', 'rejected', 'suspended'].map((s) => html`<option value="${s}" ${status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`)}</select>
        <select name="category"><option value="">Any category</option>${config.categoryOrder.map((k) => html`<option value="${k}" ${cat === k ? 'selected' : ''}>${config.categories[k].name}</option>`)}</select>
        <button class="btn btn--ink btn--sm">Filter</button>
      </form>
      <p class="muted">${note ? `${note}. ` : ''}${total} memorials</p>
      <table class="table"><thead><tr><th></th><th>Deceased</th><th>Category</th><th>Status</th><th>Tributes</th><th>Flowers</th><th>Creator</th><th>Created</th></tr></thead><tbody>
      ${rows.map((p) => html`<tr><td><img class="avatar" src="${p.photoUrl}" alt=""></td><td><a href="/admin/memorials/${p.id}"><strong>${p.name}</strong></a><br><span class="muted small">${p.years}</span></td>
        <td>${p.cat.name}${p.featured ? ' ★' : ''}</td><td>${statusChip(p.status)}</td><td>${p.tribute_count}</td><td>${p.flower_count}</td><td>${p.creator_name}</td><td>${fmtDate(p.created_at.slice(0, 10))}</td></tr>`)}</tbody></table>
      ${pager(`/admin/memorials?${new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(cat && { category: cat }) })}`, page, total, per)}`));
  });

  // ---------- Memorial detail ----------
  app.get('/admin/memorials/:id', requireAdmin, async (req, res) => {
    const p = await P.byId(req.params.id);
    if (!p) throw new HttpError(404, 'Memorial not found');
    const ninShown = req.query.nin === '1';
    if (ninShown) await D.audit(req.user, 'nin.view', `profile:${p.id}`);
    const [creator, dupesRaw, pays, tone] = await Promise.all([
      D.getDoc('users', p.creator_id),
      D.find(D.col('profiles').where('first_name_lc', '==', p.first_name_lc).where('last_name_lc', '==', p.last_name_lc).where('dod', '==', p.dod)),
      D.find(D.col('payments').where('target_id', '==', p.id).where('purpose', 'in', ['listing', 'upgrade']).orderBy('created_at', 'desc').limit(20)),
      p.tone_id ? D.getDoc('tones', p.tone_id) : null,
    ]);
    const dupes = dupesRaw.filter((d) => d.id !== p.id);
    const others = Math.max(0, ((creator && creator.memorial_count) || 1) - 1);
    const row = (k, v) => html`<tr><th>${k}</th><td>${v || html`<span class="muted">—</span>`}</td></tr>`;

    res.html(await adminLayout(req, p.status === 'pending_review' ? '/admin/review' : '/admin/memorials', p.name, html`
      <p>${statusChip(p.status)} ${p.cat.name} memorial. <a href="${p.url}" target="_blank">Open the public page</a></p>
      ${dupes.length ? html`<div class="callout callout--warn"><p>Possible duplicate: ${dupes.map((d) => html`<a href="/admin/memorials/${d.id}">${d.first_name} ${d.last_name} (${d.status})</a> `)}</p></div>` : ''}
      ${p.reject_reason ? html`<div class="callout callout--error"><p>Last reason given: ${p.reject_reason}</p></div>` : ''}

      <div class="review">
        <div class="review__docs">
          <h2 class="h-sub">Death certificate</h2>${fileLink(p.death_cert, 'death certificate')}
          <p class="small">Number <strong>${p.death_cert_number}</strong>, issued by <strong>${p.death_cert_authority}</strong>${p.cause_of_death ? html`. Cause given: ${p.cause_of_death}` : ''}</p>
          <h2 class="h-sub">Portrait</h2><img class="doc-img" src="${p.photoUrl}" alt="">
          <h2 class="h-sub">Uploader photo</h2>${fileLink(p.uploader_photo, 'uploader photo')}
          <h2 class="h-sub">Uploader ID</h2>${fileLink(p.uploader_id_doc, 'ID document')}
        </div>
        <div>
          <h2 class="h-sub">The deceased</h2>
          <table class="table table--kv"><tbody>
            ${row('Name', p.name)}${row('Also known as', p.nickname)}${row('Gender', p.gender)}
            ${row('Born', fmtDate(p.dob))}${row('Died', fmtDate(p.dod))}${row('Age', p.age?.label)}
            ${row('Place', [p.lga, p.state, p.country].join(', '))}${row('Place of death', p.place_of_death)}
            ${row('Burial', [p.burial_date ? fmtDate(p.burial_date) : '', p.burial_place].filter(Boolean).join(', '))}
            ${row('Epitaph', p.epitaph)}${row('Tone', tone?.title)}${row('Gallery', p.galleryList.length ? `${p.galleryList.length} photos` : '')}
            ${row('Video', p.video ? html`<a href="/media/${p.video}" target="_blank">${Math.round(p.video_duration || 0)}s video</a>` : '')}
          </tbody></table>
          <h2 class="h-sub">The uploader</h2>
          <table class="table table--kv"><tbody>
            ${row('Account', creator ? html`<a href="/admin/users/${creator.id}">${creator.full_name}</a>, ${creator.email}${others ? html` (${others} other memorials)` : ''}` : 'Account deleted')}
            ${row('Relationship', p.uploader_relationship)}
            ${row('NIN', ninShown ? decrypt(p.uploader_nin_enc) : html`${maskNin('0000000' + (p.uploader_nin_last4 || ''))} <a class="small" href="?nin=1">Reveal (logged)</a>`)}
            ${row('Phone', p.uploader_phone)}${row('Address', p.uploader_address)}
            ${row('Family contact', `${p.next_of_kin_name || ''}, ${p.next_of_kin_phone || ''}`)}
            ${row('Attested', fmtDateTime(p.attested_at))}
            ${row('Listing paid', p.listing_paid_at ? `${naira(p.listing_amount)} on ${fmtDateTime(p.listing_paid_at)}` : 'Not paid')}
          </tbody></table>
        </div>
      </div>

      <div class="admin-actions">
        ${p.status === 'pending_review' || p.status === 'rejected' ? html`<form method="post" action="/admin/memorials/${p.id}/approve">${csrf(req)}<button class="btn btn--brass">Approve and publish</button></form>` : ''}
        ${['pending_review', 'approved'].includes(p.status) ? html`<form method="post" action="/admin/memorials/${p.id}/reject" class="stack-form">${csrf(req)}
          <label class="field"><span>Send back with a reason</span><input name="reason" required maxlength="300" placeholder="e.g. The certificate name doesn’t match the surname entered"></label>
          <button class="btn btn--ghost">Send back to creator</button></form>` : ''}
        ${p.status === 'approved' ? html`<form method="post" action="/admin/memorials/${p.id}/suspend" class="stack-form">${csrf(req)}
          <label class="field"><span>Suspend with a reason</span><input name="reason" required maxlength="300"></label><button class="btn btn--danger">Suspend</button></form>` : ''}
        ${p.status === 'suspended' ? html`<form method="post" action="/admin/memorials/${p.id}/approve">${csrf(req)}<button class="btn btn--ink">Reinstate</button></form>` : ''}
      </div>
      ${p.status === 'approved' ? html`<div class="admin-actions">
        ${p.category !== 'legend' ? html`<form method="post" action="/admin/memorials/${p.id}/legend">${csrf(req)}<input type="hidden" name="on" value="1"><button class="btn btn--bronze">Name as a Legend</button></form>`
        : html`<form method="post" action="/admin/memorials/${p.id}/legend">${csrf(req)}<input type="hidden" name="on" value="0"><button class="btn btn--ghost">Remove Legend status (back to ${config.categories[p.previous_category || 'vvip'].name})</button></form>`}
        <form method="post" action="/admin/memorials/${p.id}/feature">${csrf(req)}<button class="btn btn--ghost">${p.featured ? 'Remove from spotlight' : 'Put in homepage spotlight'}</button></form>
        <form method="post" action="/admin/memorials/${p.id}/category" class="inline-form">${csrf(req)}
          <select name="category" aria-label="Category">${config.selectableCategories.map((k) => html`<option value="${k}" ${p.category === k ? 'selected' : ''}>${config.categories[k].name}</option>`)}</select>
          <button class="btn btn--ghost btn--sm">Change category</button></form>
      </div>` : ''}

      <h2 class="h-sub">Biography</h2><div class="prose prose--box">${paragraphs(p.biography)}</div>
      ${pays.length ? html`<h2 class="h-sub">Payments</h2><table class="table"><tbody>${pays.map((x) => html`<tr><td>${x.reference}</td><td>${x.purpose}</td><td>${naira(x.amount)}</td><td>${x.status}</td><td>${fmtDateTime(x.created_at)}</td></tr>`)}</tbody></table>` : ''}
    `));
  });

  const memAction = (name, fn) => app.post(`/admin/memorials/:id/${name}`, requireAdmin, async (req, res) => {
    const p = await P.byId(req.params.id);
    if (!p) throw new HttpError(404, 'Memorial not found');
    const msg = await fn(p, req, D.col('profiles').doc(p.id));
    D.bustCache();
    await D.audit(req.user, `memorial.${name}`, `profile:${p.id}`, req.body.reason || req.body.category || req.body.on);
    req.flash('ok', msg);
    res.redirect(`/admin/memorials/${p.id}`);
  });
  memAction('approve', async (p, req, ref) => {
    if (!p.listing_paid_at && p.category !== 'legend') throw new HttpError(400, 'This memorial hasn’t been paid for.');
    await ref.update({ status: 'approved', reject_reason: null, approved_at: p.approved_at || nowISO(), approved_by: req.user.id });
    return `${p.plain}’s memorial is live.`;
  });
  memAction('reject', async (p, req, ref) => {
    await ref.update({ status: 'rejected', reject_reason: str(req.body.reason, 300) });
    return 'Sent back to the creator with your reason.';
  });
  memAction('suspend', async (p, req, ref) => {
    await ref.update({ status: 'suspended', reject_reason: str(req.body.reason, 300) });
    return 'Memorial suspended and hidden from the public.';
  });
  memAction('legend', async (p, req, ref) => {
    if (req.body.on === '1') {
      if (p.category !== 'legend') await ref.update({ previous_category: p.category, category: 'legend', legend_since: nowISO() });
      return `${p.plain} is now a Legend.`;
    }
    await ref.update({ category: p.previous_category || 'vvip', legend_since: null });
    return 'Legend status removed.';
  });
  memAction('feature', async (p, req, ref) => { await ref.update({ featured: p.featured ? 0 : 1 }); return p.featured ? 'Removed from the spotlight.' : 'Added to the homepage spotlight.'; });
  memAction('category', async (p, req, ref) => {
    if (!config.selectableCategories.includes(req.body.category)) throw new HttpError(400, 'Choose a category.');
    await ref.update({ category: req.body.category });
    return 'Category changed. No payment was taken.';
  });

  // ---------- Edit requests ----------
  app.get('/admin/edits', requireAdmin, async (req, res) => {
    const revs = await D.find(D.col('revisions').where('status', '==', 'pending').orderBy('created_at', 'asc').limit(200));
    res.html(await adminLayout(req, '/admin/edits', 'Edit requests', revs.length ? html`<table class="table"><thead><tr><th>Memorial</th><th>Requested by</th><th>Fields</th><th>Sent</th><th></th></tr></thead><tbody>
      ${revs.map((r) => html`<tr><td>${r.profile_name}</td><td>${r.user_name}</td><td>${Object.keys(r.changes).join(', ')}</td><td>${fmtDateTime(r.created_at)}</td><td><a class="btn btn--ink btn--sm" href="/admin/edits/${r.id}">Review</a></td></tr>`)}</tbody></table>`
      : html`<div class="empty"><p>No edit requests waiting.</p></div>`));
  });

  app.get('/admin/edits/:id', requireAdmin, async (req, res) => {
    const r = await D.getDoc('revisions', req.params.id);
    if (!r) throw new HttpError(404, 'Not found');
    const p = await P.byId(r.profile_id);
    const toneIds = [p.tone_id, r.changes.tone_id].filter(Boolean);
    const tones = await D.getMany('tones', toneIds);
    const show = (k, v) => {
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return html`<span class="muted">empty</span>`;
      if (k === 'photo') return html`<img class="doc-img" src="/media/${v}" alt="">`;
      if (k === 'video') return html`<video src="/media/${v}" controls class="doc-img"></video>`;
      if (k === 'gallery') return html`<div class="thumbs">${v.map((g) => html`<img src="/media/${g}" alt="">`)}</div>`;
      if (k === 'tone_id') return (tones.get(v) || {}).title || v;
      if (k === 'timeline' || k === 'service_events') return html`<pre class="small">${JSON.stringify(v, null, 1)}</pre>`;
      if (k === 'biography' || k === 'survivors') return html`<div class="prose small">${paragraphs(v)}</div>`;
      return v;
    };
    res.html(await adminLayout(req, '/admin/edits', `Changes to ${p.name}`, html`
      <p>Edit ${p.edit_count} for this memorial. ${r.status !== 'pending' ? html`This request was ${r.status}.` : ''}</p>
      <table class="table diff"><thead><tr><th>Field</th><th>Now</th><th>Proposed</th></tr></thead><tbody>
      ${Object.entries(r.changes).map(([k, v]) => html`<tr><th>${k.replace(/_/g, ' ')}</th><td>${show(k, p[k])}</td><td>${show(k, v)}</td></tr>`)}</tbody></table>
      ${r.removedGallery?.length ? html`<p>${r.removedGallery.length} gallery photos will be removed.</p>` : ''}
      ${r.status === 'pending' ? html`<div class="admin-actions">
        <form method="post" action="/admin/edits/${r.id}/approve">${csrf(req)}<button class="btn btn--brass">Apply changes</button></form>
        <form method="post" action="/admin/edits/${r.id}/reject" class="stack-form">${csrf(req)}<label class="field"><span>Reason for declining</span><input name="note" required maxlength="300"></label><button class="btn btn--ghost">Decline and return the edit</button></form>
      </div>` : ''}`));
  });

  /** Runs fn inside a transaction with the pending revision and its memorial loaded. */
  async function withPendingRevision(id, fn) {
    if (!D.safeId(id)) throw new HttpError(404, 'Not found');
    const revRef = D.col('revisions').doc(id);
    return D.db.runTransaction(async (tx) => {
      const r = D.fromSnap(await tx.get(revRef));
      if (!r || r.status !== 'pending') throw new HttpError(404, 'This request was already handled.');
      const profRef = D.col('profiles').doc(r.profile_id);
      const p = D.fromSnap(await tx.get(profRef));
      fn(tx, r, p, revRef, profRef);
      return { r, p };
    });
  }

  app.post('/admin/edits/:id/approve', requireAdmin, async (req, res) => {
    const { r, p } = await withPendingRevision(req.params.id, (tx, r, p, revRef, profRef) => {
      tx.update(profRef, { ...changeSet(p, r.changes), last_revision: { status: 'approved', note: null, created_at: r.created_at } });
      tx.update(revRef, { status: 'approved', reviewed_at: nowISO() });
    });
    await cleanupReplaced(p, r.changes, r.removedGallery || []);
    D.bustCache();
    await D.audit(req.user, 'revision.approve', `profile:${p.id}`, Object.keys(r.changes).join(','));
    req.flash('ok', 'Changes applied to the live memorial.');
    res.redirect('/admin/edits');
  });

  app.post('/admin/edits/:id/reject', requireAdmin, async (req, res) => {
    const note = str(req.body.note, 300);
    const { r, p } = await withPendingRevision(req.params.id, (tx, r, p, revRef, profRef) => {
      tx.update(revRef, { status: 'rejected', admin_note: note, reviewed_at: nowISO() });
      // Return the edit allowance
      tx.update(profRef, { edit_count: r.prev.edit_count, last_edit_at: r.prev.last_edit_at, last_revision: { status: 'rejected', note, created_at: r.created_at } });
    });
    // Delete files uploaded with the declined change
    const extra = [];
    if (r.changes.photo && r.changes.photo !== p.photo) extra.push(r.changes.photo);
    if (r.changes.video && r.changes.video !== p.video) extra.push(r.changes.video);
    if (r.changes.gallery) extra.push(...r.changes.gallery.filter((g) => !(p.gallery || []).includes(g)));
    await Promise.all(extra.map((f) => storage.remove('public', f)));
    await D.audit(req.user, 'revision.reject', `profile:${p.id}`, note);
    req.flash('ok', 'Changes declined. The creator’s edit allowance was returned.');
    res.redirect('/admin/edits');
  });

  // ---------- Tributes and flowers moderation ----------
  /** Hides or shows a tribute or flower, keeping the memorial's counts right. */
  async function toggleVisibility(kind, id, extra = {}) {
    if (!D.safeId(id)) throw new HttpError(404, 'Not found');
    const ref = D.col(kind).doc(id);
    return D.db.runTransaction(async (tx) => {
      const item = D.fromSnap(await tx.get(ref));
      if (!item || item.status === 'pending_payment') throw new HttpError(404, 'Not found');
      const next = item.status === 'hidden' ? 'published' : 'hidden';
      const delta = next === 'hidden' ? -1 : 1;
      tx.update(ref, { status: next, ...extra });
      tx.update(D.col('profiles').doc(item.profile_id), { [kind === 'tributes' ? 'tribute_count' : 'flower_count']: D.inc(delta) });
      D.bumpStats(tx, { [kind === 'tributes' ? 'tributes_count' : 'flowers_count']: delta });
      return next;
    });
  }

  app.get('/admin/tributes', requireAdmin, async (req, res) => {
    const reported = req.query.reported === '1'; const q = str(req.query.q, 80); const words = queryWords(q);
    const page = pageNo(req); const per = 40;
    let query; let total; let rows;
    if (words.length) {
      rows = (await D.find(D.col('tributes').where('searchTokens', 'array-contains', words[0]).orderBy('created_at', 'desc').limit(200)))
        .filter((t) => t.status !== 'pending_payment' && words.every((w) => t.searchTokens.includes(w)) && (!reported || t.reported));
      total = rows.length; rows = rows.slice((page - 1) * per, page * per);
    } else {
      query = reported ? D.col('tributes').where('reported', '==', true) : D.col('tributes').where('status', 'in', ['published', 'hidden']);
      [total, rows] = await Promise.all([D.count(query), D.find(query.orderBy('created_at', 'desc').offset((page - 1) * per).limit(per))]);
    }
    res.html(await adminLayout(req, '/admin/tributes', 'Tributes', html`
      <form class="filters"><input name="q" value="${q}" placeholder="Author’s name or the memorial’s name">
        <label class="check"><input type="checkbox" name="reported" value="1" ${reported ? 'checked' : ''}> Reported only</label><button class="btn btn--ink btn--sm">Filter</button></form>
      <ul class="trib-admin">${rows.map((t) => html`<li>
        <p><strong>${t.user_name}</strong> on <a href="/m/${t.profile.slug}#tribute-${t.id}" target="_blank">${t.profile.first_name} ${t.profile.last_name}</a> <span class="muted small">${naira(t.amount)}, ${fmtDateTime(t.paid_at)}</span>
          ${t.status === 'hidden' ? html`<span class="chip chip--error">Hidden</span>` : ''}</p>
        <p>${truncate(t.message, 400)}</p>
        ${t.reported ? html`<p class="callout callout--warn small">Reported: ${(t.reports || []).map((r) => `${r.reason} (${r.user_name})`).join(' | ')}</p>` : ''}
        <div class="inline-actions">
          <form method="post" action="/admin/tributes/${t.id}/toggle">${csrf(req)}<button class="btn btn--ghost btn--sm">${t.status === 'hidden' ? 'Show again' : 'Hide'}</button></form>
          ${t.reported ? html`<form method="post" action="/admin/tributes/${t.id}/resolve">${csrf(req)}<button class="btn btn--ghost btn--sm">Dismiss reports</button></form>` : ''}
        </div></li>`)}</ul>
      ${rows.length ? '' : html`<div class="empty"><p>No tributes match.</p></div>`}
      ${pager(`/admin/tributes?${new URLSearchParams({ ...(q && { q }), ...(reported && { reported: '1' }) })}`, page, total, per)}`));
  });
  app.post('/admin/tributes/:id/toggle', requireAdmin, async (req, res) => {
    const next = await toggleVisibility('tributes', req.params.id, { reported: false, reports: [] });
    D.bustCache();
    await D.audit(req.user, `tribute.${next === 'hidden' ? 'hide' : 'show'}`, `tribute:${req.params.id}`);
    req.flash('ok', next === 'hidden' ? 'Tribute hidden.' : 'Tribute visible again.');
    res.redirect(backTo(req, '/admin/tributes'));
  });
  app.post('/admin/tributes/:id/resolve', requireAdmin, async (req, res) => {
    const t = await D.getDoc('tributes', req.params.id);
    if (!t) throw new HttpError(404, 'Not found');
    await D.col('tributes').doc(t.id).update({ reported: false, reports: [] });
    await D.audit(req.user, 'tribute.dismiss_reports', `tribute:${t.id}`);
    req.flash('ok', 'Reports dismissed.');
    res.redirect(backTo(req, '/admin/tributes'));
  });

  app.get('/admin/flowers', requireAdmin, async (req, res) => {
    const FL = require('../lib/flowers');
    const q = str(req.query.q, 80); const words = queryWords(q); const page = pageNo(req); const per = 50;
    let total; let rows;
    if (words.length) {
      rows = (await D.find(D.col('flowers').where('searchTokens', 'array-contains', words[0]).orderBy('created_at', 'desc').limit(200)))
        .filter((f) => f.status !== 'pending_payment' && words.every((w) => f.searchTokens.includes(w)));
      total = rows.length; rows = rows.slice((page - 1) * per, page * per);
    } else {
      const query = D.col('flowers').where('status', 'in', ['published', 'hidden']);
      [total, rows] = await Promise.all([D.count(query), D.find(query.orderBy('paid_at', 'desc').offset((page - 1) * per).limit(per))]);
    }
    const stats = await D.getStats();
    res.html(await adminLayout(req, '/admin/flowers', 'Flowers', html`
      <form class="filters"><input name="q" value="${q}" placeholder="Sender’s name or the memorial’s name"><button class="btn btn--ink btn--sm">Search</button></form>
      <p class="muted">${total} flowers. ${naira(stats.flowers_amount || 0)} received for flowers in total.</p>
      <table class="table"><thead><tr><th>Sent by</th><th>Memorial</th><th>Flower</th><th>Note</th><th>Amount</th><th>Date</th><th></th></tr></thead><tbody>
      ${rows.map((f) => html`<tr><td>${f.user_name}</td><td><a href="/m/${f.profile.slug}#flowers" target="_blank">${f.profile.first_name} ${f.profile.last_name}</a></td>
        <td>${(FL.FLOWERS[f.flower] || {}).name || f.flower}${f.status === 'hidden' ? html` <span class="chip chip--error">Hidden</span>` : ''}</td>
        <td class="small">${truncate(f.note || '', 140)}</td><td>${naira(f.amount)}</td><td>${fmtDateTime(f.paid_at)}</td>
        <td><a class="small" href="/f/${f.id}" target="_blank">Card</a>
          <form method="post" action="/admin/flowers/${f.id}/toggle">${csrf(req)}<button class="btn btn--ghost btn--sm">${f.status === 'hidden' ? 'Show' : 'Hide'}</button></form></td></tr>`)}</tbody></table>
      ${pager(`/admin/flowers?${new URLSearchParams(q ? { q } : {})}`, page, total, per)}`));
  });
  app.post('/admin/flowers/:id/toggle', requireAdmin, async (req, res) => {
    const next = await toggleVisibility('flowers', req.params.id);
    D.bustCache();
    await D.audit(req.user, `flower.${next === 'hidden' ? 'hide' : 'show'}`, `flower:${req.params.id}`);
    req.flash('ok', next === 'hidden' ? 'Flower hidden. Its note and name no longer show on the memorial.' : 'Flower visible again.');
    res.redirect(backTo(req, '/admin/flowers'));
  });

  // ---------- Users ----------
  app.get('/admin/users', requireAdmin, async (req, res) => {
    const q = str(req.query.q, 80); const words = queryWords(q); const page = pageNo(req); const per = 50;
    let total; let rows;
    if (q.includes('@')) {
      const u = await findByEmail(q); rows = u ? [u] : []; total = rows.length;
    } else if (words.length) {
      rows = (await D.find(D.col('users').where('searchTokens', 'array-contains', words[0]).orderBy('created_at', 'desc').limit(200))).filter((u) => words.every((w) => u.searchTokens.includes(w)));
      total = rows.length; rows = rows.slice((page - 1) * per, page * per);
    } else {
      [total, rows] = await Promise.all([D.count(D.col('users')), D.find(D.col('users').orderBy('created_at', 'desc').offset((page - 1) * per).limit(per))]);
    }
    res.html(await adminLayout(req, '/admin/users', 'Users', html`
      <form class="filters"><input name="q" value="${q}" placeholder="Name, email or phone"><button class="btn btn--ink btn--sm">Search</button></form>
      <p class="muted">${total} users</p>
      <table class="table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Memorials</th><th>Tributes</th><th>Role</th><th>Joined</th></tr></thead><tbody>
      ${rows.map((u) => html`<tr><td><a href="/admin/users/${u.id}">${u.full_name}</a>${u.status === 'banned' ? html` <span class="chip chip--error">Banned</span>` : ''}</td><td>${u.email}</td><td>${u.phone || ''}</td><td>${u.memorial_count || 0}</td><td>${u.tribute_count || 0}</td><td>${u.role}</td><td>${fmtDate(u.created_at.slice(0, 10))}</td></tr>`)}</tbody></table>
      ${pager(`/admin/users?${new URLSearchParams(q ? { q } : {})}`, page, total, per)}`));
  });

  app.get('/admin/users/:id', requireAdmin, async (req, res) => {
    const u = await D.getDoc('users', req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    const mems = (await D.find(D.col('profiles').where('creator_id', '==', u.id).orderBy('created_at', 'desc').limit(200))).map(P.decorate);
    const w = walletOf(u);
    const temp = req.session.tempPassword && req.session.tempPassword.uid === u.id ? req.session.tempPassword.pw : null;
    delete req.session.tempPassword;
    res.html(await adminLayout(req, '/admin/users', u.full_name, html`
      <table class="table table--kv"><tbody>
        <tr><th>Email</th><td>${u.email}</td></tr><tr><th>Phone</th><td>${u.phone || ''}</td></tr>
        <tr><th>Status</th><td>${u.status}, ${u.role}</td></tr><tr><th>Joined</th><td>${fmtDateTime(u.created_at)}</td></tr>
        <tr><th>Last sign in</th><td>${fmtDateTime(u.last_login_at)}</td></tr>
        <tr><th>Bank</th><td>${u.account_number ? `${u.account_name}, ${u.bank_name} ${u.account_number}` : '—'}</td></tr>
        <tr><th>Wallet</th><td>${naira(w.earned)} earned, ${naira(w.available)} available</td></tr>
      </tbody></table>
      ${temp ? html`<div class="callout callout--warn"><p>Temporary password: <code>${temp}</code>. Share it with the user privately. It won’t be shown again.</p></div>` : ''}
      ${u.id !== req.user.id ? html`<div class="admin-actions">
        <form method="post" action="/admin/users/${u.id}/ban">${csrf(req)}<button class="btn ${u.status === 'banned' ? 'btn--ink' : 'btn--danger'}">${u.status === 'banned' ? 'Restore account' : 'Ban account'}</button></form>
        <form method="post" action="/admin/users/${u.id}/role">${csrf(req)}<button class="btn btn--ghost">${u.role === 'admin' ? 'Remove admin access' : 'Make admin'}</button></form>
        <form method="post" action="/admin/users/${u.id}/reset">${csrf(req)}<button class="btn btn--ghost">Reset password</button></form>
      </div>` : ''}
      <h2 class="h-sub">Memorials created</h2>
      ${mems.length ? html`<table class="table"><tbody>${mems.map((p) => html`<tr><td><a href="/admin/memorials/${p.id}">${p.name}</a></td><td>${p.cat.name}</td><td>${statusChip(p.status)}</td></tr>`)}</tbody></table>` : html`<p class="muted">None.</p>`}`));
  });

  const userAction = (name, fn) => app.post(`/admin/users/:id/${name}`, requireAdmin, async (req, res) => {
    const u = await D.getDoc('users', req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    if (u.id === req.user.id && name !== 'reset') throw new HttpError(400, 'You can’t do that to your own account.');
    const msg = await fn(u, req, D.col('users').doc(u.id));
    if (msg) req.flash('ok', msg);
    res.redirect(`/admin/users/${u.id}`);
  });
  userAction('ban', async (u, req, ref) => {
    const next = u.status === 'banned' ? 'active' : 'banned';
    await ref.update({ status: next });
    if (next === 'banned') await endSessionsForUser(u.id);
    await D.audit(req.user, `user.${next === 'banned' ? 'ban' : 'restore'}`, `user:${u.id}`);
    return next === 'banned' ? 'Account banned and signed out.' : 'Account restored.';
  });
  userAction('role', async (u, req, ref) => {
    const next = u.role === 'admin' ? 'user' : 'admin';
    await ref.update({ role: next });
    await D.audit(req.user, 'user.role', `user:${u.id}`, next);
    return 'Role updated.';
  });
  userAction('reset', async (u, req, ref) => {
    const pw = token(5);
    await ref.update({ password_hash: hashPassword(pw) });
    await endSessionsForUser(u.id, req._session.id);
    await D.audit(req.user, 'user.reset_password', `user:${u.id}`);
    req.session.tempPassword = { uid: u.id, pw };
    return null;
  });

  // ---------- Payments ----------
  app.get('/admin/payments', requireAdmin, async (req, res) => {
    const status = str(req.query.status, 10); const purpose = str(req.query.purpose, 10);
    const page = pageNo(req); const per = 50;
    let query = D.col('payments');
    if (status) query = query.where('status', '==', status);
    if (purpose) query = query.where('purpose', '==', purpose);
    const [total, rows, stats] = await Promise.all([D.count(query), D.find(query.orderBy('created_at', 'desc').offset((page - 1) * per).limit(per)), D.getStats()]);
    res.html(await adminLayout(req, '/admin/payments', 'Payments', html`
      <form class="filters">
        <select name="purpose"><option value="">Any purpose</option>${['listing', 'tribute', 'flower', 'upgrade'].map((s) => html`<option ${purpose === s ? 'selected' : ''}>${s}</option>`)}</select>
        <select name="status"><option value="">Any status</option>${['success', 'pending', 'failed'].map((s) => html`<option ${status === s ? 'selected' : ''}>${s}</option>`)}</select>
        <button class="btn btn--ink btn--sm">Filter</button></form>
      <p class="muted">${total} payments. ${naira(stats.gross || 0)} received in total.</p>
      <table class="table"><thead><tr><th>Reference</th><th>Payer</th><th>Purpose</th><th>Amount</th><th>Status</th><th>Provider</th><th>Date</th></tr></thead><tbody>
      ${rows.map((p) => html`<tr><td class="small">${p.reference}</td><td>${p.user_name}</td><td>${p.purpose}</td><td>${naira(p.amount)}</td><td>${p.status}</td><td>${p.provider}</td><td>${fmtDateTime(p.created_at)}</td></tr>`)}</tbody></table>
      ${pager(`/admin/payments?${new URLSearchParams({ ...(status && { status }), ...(purpose && { purpose }) })}`, page, total, per)}`));
  });

  // ---------- Withdrawals ----------
  app.get('/admin/withdrawals', requireAdmin, async (req, res) => {
    const rows = (await D.find(D.col('withdrawals').orderBy('created_at', 'desc').limit(200))).sort((a, b) => (b.status === 'pending') - (a.status === 'pending'));
    res.html(await adminLayout(req, '/admin/withdrawals', 'Withdrawals', rows.length ? html`<p class="muted">Pay each request by bank transfer, then mark it as paid with the transfer reference.</p>
      <table class="table"><thead><tr><th>Requested</th><th>Creator</th><th>Amount</th><th>Bank details</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((w) => html`<tr><td>${fmtDateTime(w.created_at)}</td><td><a href="/admin/users/${w.user_id}">${w.user_name}</a></td><td><strong>${naira(w.amount)}</strong></td>
        <td>${w.account_name}<br>${w.bank_name} ${w.account_number}</td><td>${w.status}${w.admin_note ? html`<br><small class="muted">${w.admin_note}</small>` : ''}</td>
        <td>${w.status === 'pending' ? html`<form method="post" action="/admin/withdrawals/${w.id}" class="stack-form">${csrf(req)}
          <input name="note" placeholder="Transfer reference or reason" maxlength="200" aria-label="Note">
          <span class="inline-actions"><button class="btn btn--ink btn--sm" name="action" value="paid">Mark paid</button><button class="btn btn--ghost btn--sm" name="action" value="rejected">Reject</button></span></form>` : ''}</td></tr>`)}</tbody></table>`
      : html`<div class="empty"><p>No withdrawal requests yet.</p></div>`));
  });
  app.post('/admin/withdrawals/:id', requireAdmin, async (req, res) => {
    const action = req.body.action === 'paid' ? 'paid' : 'rejected';
    if (!D.safeId(req.params.id)) throw new HttpError(404, 'Not found');
    const ref = D.col('withdrawals').doc(req.params.id);
    await D.db.runTransaction(async (tx) => {
      const w = D.fromSnap(await tx.get(ref));
      if (!w || w.status !== 'pending') throw new HttpError(400, 'That request was already processed.');
      tx.update(ref, { status: action, admin_note: str(req.body.note, 200) || null, processed_at: nowISO() });
      const userRef = D.col('users').doc(w.user_id);
      if (action === 'paid') { tx.update(userRef, { paid_out: D.inc(w.amount) }); D.bumpStats(tx, { paid_out: w.amount }); } else tx.update(userRef, { withdrawn: D.inc(-w.amount) });
    });
    await D.audit(req.user, `withdrawal.${action}`, `withdrawal:${req.params.id}`, req.body.note);
    req.flash('ok', action === 'paid' ? 'Marked as paid.' : 'Request rejected. The amount is back in the creator’s balance.');
    res.redirect('/admin/withdrawals');
  });

  // ---------- Charity ----------
  app.get('/admin/charity', requireAdmin, async (req, res) => {
    const [stats, partnersRaw, recent] = await Promise.all([D.getStats(), D.find(D.col('charities')), D.find(D.col('charity_disbursements').orderBy('created_at', 'desc').limit(30))]);
    const raised = stats.charity_total || 0; const given = stats.charity_given || 0;
    const partners = partnersRaw.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    res.html(await adminLayout(req, '/admin/charity', 'Charity', html`
      <div class="stats">${kpi(naira(raised), 'Raised from tributes and flowers')}${kpi(naira(given), 'Given out')}${kpi(naira(raised - given), 'Balance to give')}</div>
      <div class="two-col">
        <form class="card form" method="post" action="/admin/charity/disburse">${csrf(req)}
          <h2 class="h-sub">Record a disbursement</h2>
          <label class="field"><span>Partner</span><select name="charity_id" required>${partners.filter((c) => c.active).map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>
          <label class="field"><span>Amount (₦)</span><input type="number" name="amount" min="1" max="${Math.floor(raised - given)}" required></label>
          <label class="field"><span>Transfer reference</span><input name="reference" maxlength="80"></label>
          <label class="field"><span>Note <em class="opt">shown publicly</em></span><input name="note" maxlength="200"></label>
          <button class="btn btn--ink">Record disbursement</button>
        </form>
        <form class="card form" method="post" action="/admin/charity/partners">${csrf(req)}
          <h2 class="h-sub">Add a partner</h2>
          <label class="field"><span>Name</span><input name="name" required maxlength="120"></label>
          <label class="field"><span>Type</span><select name="kind"><option value="hospital">Hospital</option><option value="orphanage">Orphanage</option><option value="research">Health research</option></select></label>
          <label class="field"><span>Location</span><input name="location" maxlength="80"></label>
          <label class="field"><span>Description</span><textarea name="description" rows="3" maxlength="400"></textarea></label>
          <button class="btn btn--ghost">Add partner</button>
        </form>
      </div>
      <h2 class="h-sub">Partners</h2>
      <table class="table"><thead><tr><th>Name</th><th>Type</th><th>Given</th><th>Status</th><th></th></tr></thead><tbody>
      ${partners.map((c) => html`<tr><td>${c.name}<br><span class="muted small">${c.location || ''}</span></td><td>${c.kind}</td><td>${naira(c.given || 0)}</td><td>${c.active ? 'Active' : 'Inactive'}</td>
        <td><form method="post" action="/admin/charity/partners/${c.id}/toggle">${csrf(req)}<button class="btn btn--ghost btn--sm">${c.active ? 'Deactivate' : 'Activate'}</button></form></td></tr>`)}</tbody></table>
      <h2 class="h-sub">Disbursements</h2>
      <table class="table"><tbody>${recent.map((d) => html`<tr><td>${fmtDate(d.created_at.slice(0, 10))}</td><td>${d.charity_name}</td><td>${naira(d.amount)}</td><td>${d.reference || ''}</td><td class="muted">${d.note || ''}</td></tr>`)}</tbody></table>`));
  });
  app.post('/admin/charity/disburse', requireAdmin, async (req, res) => {
    const amount = Number(req.body.amount);
    if (!D.safeId(req.body.charity_id)) throw new HttpError(400, 'Choose a partner.');
    const charityRef = D.col('charities').doc(req.body.charity_id);
    await D.db.runTransaction(async (tx) => {
      const stats = (await tx.get(D.statsRef())).data() || {};
      const charity = D.fromSnap(await tx.get(charityRef));
      if (!charity) throw new HttpError(400, 'Choose a partner.');
      const bal = (stats.charity_total || 0) - (stats.charity_given || 0);
      if (!(amount > 0) || amount > bal + 0.001) throw new HttpError(400, `Enter an amount up to ${naira(bal)}.`);
      tx.create(D.col('charity_disbursements').doc(), { charity_id: charity.id, charity_name: charity.name, amount, reference: str(req.body.reference, 80), note: str(req.body.note, 200), created_by: req.user.id, created_at: nowISO() });
      tx.update(charityRef, { given: D.inc(amount) });
      D.bumpStats(tx, { charity_given: amount });
    });
    await D.audit(req.user, 'charity.disburse', `charity:${req.body.charity_id}`, amount);
    req.flash('ok', `${naira(amount)} recorded and published on the charity page.`);
    res.redirect('/admin/charity');
  });
  app.post('/admin/charity/partners', requireAdmin, async (req, res) => {
    const name = str(req.body.name, 120); if (!name) throw new HttpError(400, 'Enter a name.');
    await D.col('charities').add({ name, kind: ['hospital', 'orphanage', 'research'].includes(req.body.kind) ? req.body.kind : 'hospital', location: str(req.body.location, 80), description: str(req.body.description, 400), active: true, given: 0, created_at: nowISO() });
    await D.audit(req.user, 'charity.add', name);
    req.flash('ok', 'Partner added.');
    res.redirect('/admin/charity');
  });
  app.post('/admin/charity/partners/:id/toggle', requireAdmin, async (req, res) => {
    const c = await D.getDoc('charities', req.params.id);
    if (!c) throw new HttpError(404, 'Not found');
    await D.col('charities').doc(c.id).update({ active: !c.active });
    res.redirect('/admin/charity');
  });

  // ---------- Tones ----------
  app.get('/admin/tones', requireAdmin, async (req, res) => {
    const tones = (await D.find(D.col('tones'))).sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
    const used = await Promise.all(tones.map((t) => D.count(D.col('profiles').where('tone_id', '==', t.id))));
    res.html(await adminLayout(req, '/admin/tones', 'Memorial tones', html`
      <p class="muted">VIP, VVIP and Legend creators choose from the active tones. Only upload music you own or have licensed for this use.</p>
      <table class="table"><thead><tr><th>Tone</th><th>Preview</th><th>Used by</th><th>Status</th><th></th></tr></thead><tbody>
      ${tones.map((t, i) => html`<tr><td><strong>${t.title}</strong><br><span class="muted small">${t.description || ''}</span></td>
        <td><audio src="${toneUrl(t.file)}" controls preload="none"></audio></td><td>${used[i]}</td><td>${t.active ? 'Active' : 'Hidden'}</td>
        <td><form method="post" action="/admin/tones/${t.id}/toggle">${csrf(req)}<button class="btn btn--ghost btn--sm">${t.active ? 'Hide' : 'Show'}</button></form></td></tr>`)}</tbody></table>
      <form class="card form narrow-form" method="post" action="/admin/tones" enctype="multipart/form-data">${csrf(req)}
        <h2 class="h-sub">Add a tone</h2>
        <label class="field"><span>Title</span><input name="title" required maxlength="60"></label>
        <label class="field"><span>Description</span><input name="description" maxlength="120"></label>
        <label class="field"><span>Audio file</span><input type="file" name="file" accept="audio/mpeg,audio/ogg" required><small>MP3 or OGG, up to 8MB. It loops on the memorial.</small></label>
        <button class="btn btn--ink">Add tone</button>
      </form>`));
  });
  app.post('/admin/tones', requireAdmin, async (req, res) => {
    const f = (req.files.file || [])[0];
    if (!f) throw new HttpError(400, 'Choose an audio file.');
    const t = sniff(f.data);
    if (!t || t.kind !== 'audio') throw new HttpError(400, 'Use an MP3 or OGG file.');
    if (f.size > 8 * 1048576) throw new HttpError(400, 'The file is larger than 8MB.');
    const name = `tone-${token(6)}.${t.ext}`;
    await storage.put('public', name, f.data);
    await D.col('tones').add({ title: str(req.body.title, 60) || 'Untitled tone', description: str(req.body.description, 120), file: name, active: true, sort: 100 });
    D.bustCache();
    await D.audit(req.user, 'tone.add', name);
    req.flash('ok', 'Tone added.');
    res.redirect('/admin/tones');
  });
  app.post('/admin/tones/:id/toggle', requireAdmin, async (req, res) => {
    const t = await D.getDoc('tones', req.params.id);
    if (!t) throw new HttpError(404, 'Not found');
    await D.col('tones').doc(t.id).update({ active: !t.active });
    D.bustCache();
    res.redirect('/admin/tones');
  });

  // ---------- Pricing ----------
  app.get('/admin/settings', requireAdmin, async (req, res) => {
    res.html(await adminLayout(req, '/admin/settings', 'Pricing', html`
      <form class="card form narrow-form" method="post" action="/admin/settings">${csrf(req)}
        <table class="table"><thead><tr><th>Category</th><th>Listing fee (₦)</th><th>Tribute fee (₦)</th><th>Flower fee (₦)</th><th>Tribute word limit</th></tr></thead><tbody>
        ${config.categoryOrder.map((k) => { const pr = D.prices(k); return html`<tr><th>${config.categories[k].name}</th>
          <td>${pr.listingFee === null ? html`<span class="muted">Chosen by admins</span>` : html`<input type="number" min="0" name="listing_${k}" value="${pr.listingFee}" aria-label="${k} listing fee">`}</td>
          <td><input type="number" min="0" name="tribute_${k}" value="${pr.tributeFee}" aria-label="${k} tribute fee"></td>
          <td><input type="number" min="0" name="flower_${k}" value="${pr.flowerFee}" aria-label="${k} flower fee"></td>
          <td>${config.categories[k].tributeWords} words</td></tr>`; })}</tbody></table>
        <p class="muted small">Tribute and flower split: ${config.split.creator}% creator, ${config.split.charity}% charity, ${config.split.platform}% platform. New prices apply to new payments only.</p>
        <button class="btn btn--ink">Save prices</button>
      </form>`));
  });
  app.post('/admin/settings', requireAdmin, async (req, res) => {
    const values = {};
    const take = (key) => { const v = Number(req.body[key]); if (req.body[key] !== undefined && req.body[key] !== '' && v >= 0 && Number.isFinite(v)) values[key] = Math.round(v); };
    for (const k of config.categoryOrder) {
      if (config.categories[k].listingFee !== null) take(`listing_${k}`);
      take(`tribute_${k}`); take(`flower_${k}`);
    }
    await D.savePrices(values);
    await D.audit(req.user, 'settings.prices', null, JSON.stringify(values).slice(0, 300));
    req.flash('ok', 'Prices saved.');
    res.redirect('/admin/settings');
  });

  // ---------- Audit log ----------
  app.get('/admin/audit', requireAdmin, async (req, res) => {
    const page = pageNo(req); const per = 100;
    const [total, rows] = await Promise.all([D.count(D.col('audit_log')), D.find(D.col('audit_log').orderBy('created_at', 'desc').offset((page - 1) * per).limit(per))]);
    res.html(await adminLayout(req, '/admin/audit', 'Audit log', html`<table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
      ${rows.map((a) => html`<tr><td>${fmtDateTime(a.created_at)}</td><td>${a.actor_name || 'System'}</td><td>${a.action}</td><td>${a.target || ''}</td><td class="muted small">${truncate(a.detail || '', 100)}</td></tr>`)}</tbody></table>
      ${pager('/admin/audit?', page, total, per)}`));
  });
}

module.exports = { register };
