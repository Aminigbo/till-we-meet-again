const config = require('../lib/config');
const D = require('../lib/db');
const P = require('../lib/profiles');
const { startPayment } = require('../lib/payments');
const { HttpError } = require('../lib/app');
const { html, naira, str, truncate, countWords, nowISO, searchTokens } = require('../lib/util');
const FL = require('../lib/flowers');
const { layout, stoneCard, pager, icon, csrf, shareLinks } = require('../views/layout');
const { memorialPage, programmePage, paragraphs, flowerList } = require('../views/memorial');
const pages = require('../views/pages');
const S = require('../lib/search');
const { searchPage, CAT_INTRO } = require('../views/search');
const { requireAuth } = require('./auth');


function lawn(cat, rows, total) {
  const c = config.categories[cat];
  return html`<section class="lawn lawn--${cat}" aria-labelledby="lawn-${cat}">
    <div class="lawn__head">
      <div><h2 id="lawn-${cat}">${c.name}</h2><p>${CAT_INTRO[cat]}</p></div>
      ${total > 0 ? html`<a class="lawn__all" href="/memorials/${cat}">See all ${total} ${c.name === 'Legends' ? 'Legends' : c.name + ' memorials'}</a>` : ''}
    </div>
    ${rows.length ? html`<div class="lawn__row" tabindex="0" aria-label="${c.name} memorials, scroll sideways">${rows.map((p) => stoneCard(p))}</div>`
    : html`<p class="lawn__empty">No ${c.name} memorials yet.${cat !== 'legend' ? html` <a href="/create?category=${cat}">Create one</a>` : ''}</p>`}
  </section>`;
}

// Page views are added up in memory and written every 30 seconds, so a busy memorial
// doesn't hit Firestore's write limit for a single document.
const viewBuffer = new Map();
setInterval(async () => {
  if (!viewBuffer.size) return;
  const batch = D.db.batch();
  for (const [id, n] of viewBuffer) batch.update(D.col('profiles').doc(id), { views: D.inc(n) });
  viewBuffer.clear();
  await batch.commit().catch((e) => console.error('views', e.message));
}, 30000).unref();

const asAuthor = (r) => ({ ...r, full_name: r.user_name });

/** Homepage data, cached for 30 seconds (cleared when memorials, tributes or flowers change). */
const homeData = () => D.cached('home', 30000, async () => {
  const [sections, spot, mem, stats] = await Promise.all([
    Promise.all(config.categoryOrder.map(async (cat) => ({ cat, ...(await P.listApproved({ category: cat, limit: config.homePerCategory })) }))),
    D.find(D.col('profiles').where('status', '==', 'approved').where('category', 'in', ['legend', 'vvip']).orderBy('featured', 'desc').orderBy('approved_at', 'desc').limit(1)),
    D.count(D.col('profiles').where('status', '==', 'approved')),
    D.getStats(),
  ]);
  const spotlight = spot.map(P.decorate)[0] || sections.flatMap((x) => x.rows)[0];
  return { sections, spotlight, totals: { mem, trib: stats.tributes_count || 0, flw: stats.flowers_count || 0, charity: stats.charity_total || 0 } };
});

function register(app) {
  app.get('/', async (req, res) => {
    const { sections, spotlight, totals } = await homeData();
    res.html(layout(req, {
      bodyClass: 'page-home',
      body: html`<section class="hero">
        <div class="hero__in">
          <div class="hero__copy">
            <h1>A resting place everyone can visit.</h1>
            <p class="hero__lede">Publish a verified memorial for someone you have lost. Friends near and far can read their story, lay a flower and leave a tribute. Part of every tribute goes to hospitals, orphanages and health research.</p>
            <div class="hero__cta"><a class="btn btn--brass btn--lg" href="/create">Create a memorial</a><a class="btn btn--ghost-light btn--lg" href="#memorials">Visit the memorials</a></div>
            <form class="search" action="/memorials" role="search">
              <label class="sr" for="q">Search memorials</label>
              <input id="q" name="q" placeholder="Search by name" autocomplete="off">
              <button class="btn btn--ink" aria-label="Search">${icon('search')}</button>
            </form>
            <p class="hero__more"><a href="/memorials#filters">Search by year of death, state or LGA</a></p>
            <p class="hero__stats">${totals.mem.toLocaleString()} memorials. ${totals.trib.toLocaleString()} tributes. ${totals.flw.toLocaleString()} flowers. ${naira(totals.charity)} raised for charity.</p>
          </div>
          <div class="hero__stone">${spotlight ? stoneCard(spotlight, { large: true }) : ''}<div class="hero__ground" aria-hidden="true"></div></div>
        </div>
      </section>
      <div id="memorials" class="lawns">${sections.map((s) => lawn(s.cat, s.rows, s.total))}</div>
      <section class="explain">
        <div class="explain__in">
          <h2>How tillwemeet works</h2>
          <ol class="explain__steps">
            <li><h3>Create the memorial</h3><p>Add their story and photo, choose Regular, VIP or VVIP, and attach the death certificate.</p></li>
            <li><h3>We verify it</h3><p>Our team checks the certificate and your identity before anything is published.</p></li>
            <li><h3>Friends leave tributes and flowers</h3><p>Each tribute or flower sends 40% to the family and 40% to charity.</p></li>
          </ol>
          <a class="btn btn--ink" href="/how-it-works">Read how it works</a>
        </div>
      </section>`,
    }));
  });

  const PER_PAGE = 30;
  const listPage = async (req, res, category) => {
    const page = Math.min(200, Math.max(1, Number(req.query.page) || 1));
    const f = S.parseFilters(req.query);
    const [{ rows, total, capped }, places] = await Promise.all([
      S.searchMemorials({ category, ...f, limit: PER_PAGE, offset: (page - 1) * PER_PAGE }),
      S.places({ country: f.country || 'Nigeria', state: f.state }),
    ]);
    res.html(searchPage(req, { category, f, rows: rows.map(P.decorate), total, capped, page, perPage: PER_PAGE, places }));
  };

  // Name suggestions for the search box
  app.get('/api/memorials/suggest', async (req, res) => {
    req.rateLimit('suggest', 120, 60 * 1000);
    const rows = (await S.suggest(str(req.query.q, 80))).map(P.decorate);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ results: rows.map((p) => ({ name: p.name, years: p.years, place: [p.lga, p.state].filter(Boolean).join(', '), url: p.url, photo: p.photoUrl })) });
  });

  // States and LGAs to suggest in the location filters
  app.get('/api/places', async (req, res) => {
    req.rateLimit('places', 120, 60 * 1000);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json(await S.places({ country: str(req.query.country, 60), state: str(req.query.state, 60) }));
  });

  app.get('/memorials', async (req, res) => listPage(req, res, null));
  app.get('/memorials/:category', async (req, res) => {
    if (!config.categories[req.params.category]) throw new HttpError(404, 'Page not found');
    await listPage(req, res, req.params.category);
  });

  async function loadVisible(req) {
    const p = await P.bySlug(req.params.slug);
    if (!p) throw new HttpError(404, 'We couldn’t find that memorial.');
    const isOwner = req.user && req.user.id === p.creator_id;
    const isAdmin = req.user && req.user.role === 'admin';
    if (p.status !== 'approved' && !isOwner && !isAdmin) throw new HttpError(404, 'We couldn’t find that memorial.');
    return { p, isOwner, preview: p.status !== 'approved' };
  }

  app.get('/m/:slug', async (req, res) => {
    const { p, isOwner, preview } = await loadVisible(req);
    if (!preview && !isOwner) viewBuffer.set(p.id, (viewBuffer.get(p.id) || 0) + 1);
    const uid = req.user && req.user.id;
    const [tributes, myTribute, candle, tone, flowers, pendingFlower] = await Promise.all([
      D.find(D.col('tributes').where('profile_id', '==', p.id).where('status', '==', 'published').orderBy('paid_at', 'desc').limit(300)),
      uid ? D.getDoc('tributes', `${p.id}_${uid}`) : null,
      uid ? D.getDoc('candles', `${p.id}_${uid}`) : null,
      p.cat.tone && p.tone_id ? D.getDoc('tones', p.tone_id) : null,
      D.find(D.col('flowers').where('profile_id', '==', p.id).where('status', '==', 'published').orderBy('paid_at', 'desc').limit(60)),
      uid ? D.first(D.col('flowers').where('profile_id', '==', p.id).where('user_id', '==', uid).where('status', '==', 'pending_payment')) : null,
    ]);
    res.html(memorialPage(req, p, {
      tributes: tributes.map(asAuthor), myTribute, litCandle: !!candle, tone, isOwner, preview,
      charityRaised: p.charity_raised || 0, flowers: flowers.map(asAuthor), pendingFlower,
    }));
  });

  app.get('/m/:slug/programme', requireAuth, async (req, res) => {
    const { p } = await loadVisible(req);
    if (p.cat.rank < 3) throw new HttpError(404, 'Printable programmes are part of VVIP and Legend memorials.');
    res.html(programmePage(req, p));
  });

  app.post('/m/:slug/tribute', requireAuth, async (req, res) => {
    const { p, isOwner, preview } = await loadVisible(req);
    if (preview) throw new HttpError(400, 'Tributes open once the memorial is published.');
    if (isOwner) throw new HttpError(400, 'You created this memorial, so you can’t leave a tribute on it.');
    const message = str(req.body.message, 20000); const relationship = str(req.body.relationship, 60);
    const maxWords = p.cat.tributeWords;
    if (message.length < 20) { req.flash('error', 'Write at least 20 characters for your tribute.'); return res.redirect(`${p.url}#tribute-form`); }
    if (countWords(message) > maxWords) {
      req.flash('error', `Your tribute has ${countWords(message)} words. ${p.cat.name} memorials allow up to ${maxWords} words, so shorten it a little.`);
      req.session.tributeDraft = { profile: p.id, message, relationship };
      return res.redirect(`${p.url}#tribute-form`);
    }
    const fee = D.prices(p.category).tributeFee;
    // The tribute's id is memorial + person, so each person can only ever have one per memorial.
    const id = `${p.id}_${req.user.id}`;
    const ref = D.col('tributes').doc(id);
    const already = await D.db.runTransaction(async (tx) => {
      const existing = D.fromSnap(await tx.get(ref));
      if (existing && existing.status !== 'pending_payment') return existing;
      tx.set(ref, {
        profile_id: p.id, user_id: req.user.id, user_name: req.user.full_name, relationship, message, amount: fee,
        status: 'pending_payment', paid_at: null, created_at: existing ? existing.created_at : nowISO(), reported: false, reports: [],
        profile: { slug: p.slug, first_name: p.first_name, last_name: p.last_name, titles: p.titles || '', category: p.category },
        searchTokens: searchTokens(req.user.full_name, p.first_name, p.last_name),
      });
      return null;
    });
    if (already) { req.flash('info', 'You have already left a tribute on this memorial. Each person can leave one.'); return res.redirect(`${p.url}#tribute-${already.id}`); }
    res.redirect(await startPayment({ user: req.user, purpose: 'tribute', targetId: id, amount: fee, successPath: `${p.url}#tribute-${id}`, cancelPath: `${p.url}#tribute-form` }));
  });

  app.post('/m/:slug/candle', requireAuth, async (req, res) => {
    const { p, preview } = await loadVisible(req);
    if (preview || p.cat.rank < 2) throw new HttpError(400, 'Candles are available on VIP, VVIP and Legend memorials.');
    const candleRef = D.col('candles').doc(`${p.id}_${req.user.id}`);
    const lit = await D.db.runTransaction(async (tx) => {
      if ((await tx.get(candleRef)).exists) return false;
      tx.create(candleRef, { profile_id: p.id, user_id: req.user.id, created_at: nowISO() });
      tx.update(D.col('profiles').doc(p.id), { candles: D.inc(1) });
      return true;
    });
    if (req.headers.accept?.includes('application/json')) return res.json({ ok: true, candles: (p.candles || 0) + (lit ? 1 : 0) });
    req.flash('ok', 'You lit a candle.');
    res.redirect(p.url);
  });

  // Shareable page for a single tribute (gives social previews the right title and image)
  app.get('/t/:id', async (req, res) => {
    const doc = await D.getDoc('tributes', req.params.id);
    if (!doc || doc.status !== 'published') throw new HttpError(404, 'That tribute isn’t available.');
    const t = asAuthor(doc);
    const p = await P.byId(t.profile_id);
    if (!p || p.status !== 'approved') throw new HttpError(404, 'That tribute isn’t available.');
    res.html(layout(req, {
      title: `${t.full_name}'s tribute to ${p.name}`,
      og: { title: `${t.full_name}'s tribute to ${p.name}`, description: truncate(t.message, 180), image: `${config.baseUrl}${p.photoUrl}`, url: `${config.baseUrl}/t/${t.id}` },
      bodyClass: `page-tribute theme-${p.category}`,
      body: html`<section class="narrow tribute-solo">
        <a class="tribute-solo__who" href="${p.url}"><img src="${p.photoUrl}" alt=""><span><strong>${p.name}</strong><span>${p.years}</span></span></a>
        <blockquote class="tribute-solo__quote">${paragraphs(t.message)}</blockquote>
        <p class="tribute-solo__by">${t.full_name}${t.relationship ? `, ${t.relationship}` : ''}</p>
        ${require('../views/layout').shareLinks(`${config.baseUrl}/t/${t.id}`, `${t.full_name}'s tribute to ${p.name} on tillwemeet:`)}
        <p><a class="btn btn--ink" href="${p.url}">Visit the memorial</a></p>
      </section>`,
    }));
  });

  // ---------- Flowers ----------
  app.post('/m/:slug/flower', requireAuth, async (req, res) => {
    const { p, preview } = await loadVisible(req);
    if (preview) throw new HttpError(400, 'Flowers can be laid once the memorial is published.');
    const flower = FL.KEYS.includes(req.body.flower) ? req.body.flower : null;
    const note = str(req.body.note, 2000);
    if (!flower) { req.flash('error', 'Choose a flower to lay.'); return res.redirect(`${p.url}#lay-flower`); }
    if (countWords(note) > config.flowerNoteWords) {
      req.flash('error', `Your note has ${countWords(note)} words. Keep it to ${config.flowerNoteWords} words or fewer.`);
      req.session.flowerDraft = { profile: p.id, flower, note };
      return res.redirect(`${p.url}#lay-flower`);
    }
    const fee = D.prices(p.category).flowerFee;
    // Re-use an unpaid flower from the same visitor rather than piling up abandoned ones
    const pending = await D.first(D.col('flowers').where('profile_id', '==', p.id).where('user_id', '==', req.user.id).where('status', '==', 'pending_payment'));
    const ref = pending ? D.col('flowers').doc(pending.id) : D.col('flowers').doc();
    await ref.set({
      profile_id: p.id, user_id: req.user.id, user_name: req.user.full_name, flower, note: note || null, amount: fee,
      status: 'pending_payment', paid_at: null, created_at: nowISO(),
      profile: { slug: p.slug, first_name: p.first_name, last_name: p.last_name, titles: p.titles || '', category: p.category },
      searchTokens: searchTokens(req.user.full_name, p.first_name, p.last_name),
    });
    res.redirect(await startPayment({ user: req.user, purpose: 'flower', targetId: ref.id, amount: fee, successPath: `/f/${ref.id}?new=1`, cancelPath: `${p.url}#lay-flower` }));
  });

  async function loadFlower(req) {
    const doc = await D.getDoc('flowers', req.params.id);
    const f = doc && asAuthor(doc);
    const mine = f && req.user && (req.user.id === f.user_id || req.user.role === 'admin');
    if (!f || (f.status !== 'published' && !mine) || f.status === 'pending_payment') throw new HttpError(404, 'That flower isn’t available.');
    const p = await P.byId(f.profile_id);
    if (!p || (p.status !== 'approved' && !mine)) throw new HttpError(404, 'That flower isn’t available.');
    return { f, p, mine };
  }

  // The shareable card, as an SVG image
  app.get('/f/:id/card.svg', async (req, res) => {
    const { f, p } = await loadFlower(req);
    const svg = await FL.cardSvg({ flower: f, profile: p, giver: f.full_name });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.end(svg);
  });

  // Card page: download, share, or go back to the memorial
  app.get('/f/:id', async (req, res) => {
    const { f, p, mine } = await loadFlower(req);
    const fl = FL.FLOWERS[f.flower];
    const url = `${config.baseUrl}/f/${f.id}`;
    const shareText = `I laid a ${fl.name.toLowerCase()} for ${p.name} on tillwemeet. Visit the memorial:`;
    res.html(layout(req, {
      title: `${f.full_name} laid a ${fl.name.toLowerCase()} for ${p.name}`,
      og: { title: `${f.full_name} laid a ${fl.name.toLowerCase()} for ${p.name}`, description: `${fl.meaning}. In loving memory of ${p.name} (${p.years}).`, image: `${config.baseUrl}${p.photoUrl}`, url },
      bodyClass: `page-flower theme-${p.category}`,
      body: html`<section class="flower-card-page">
        <div class="flower-card-page__card"><img src="/f/${f.id}/card.svg" alt="Card: ${f.full_name} laid a ${fl.name.toLowerCase()} for ${p.name}, ${p.years}" width="540" height="675" data-card-img></div>
        <div class="flower-card-page__side">
          <h1>${mine && req.query.new ? 'Your flower has been laid' : `${f.full_name} laid a ${fl.name.toLowerCase()}`}</h1>
          <p class="lede">${mine && req.query.new ? html`Your ${fl.name.toLowerCase()} now rests at the memorial of ${p.name}. Download the card below and share it with family and friends.` : html`In loving memory of ${p.name}, ${p.years}.`}</p>
          ${f.note ? html`<blockquote class="flower-note">${f.note}</blockquote>` : ''}
          <div class="actions">
            <button type="button" class="btn btn--brass" data-download-card="/f/${f.id}/card.svg" data-filename="tillwemeet-flower-${p.slug}.png">${icon('download')}<span>Download card</span></button>
            <a class="btn btn--ghost" href="${p.url}#flowers">Visit the memorial</a>
          </div>
          <h2 class="h-sub">Share</h2>
          ${shareLinks(url, shareText)}
          <p class="muted small">On a phone, download the card and post it to your WhatsApp status or Instagram story.</p>
        </div>
      </section>`,
    }));
  });

  // Everyone who has laid a flower
  app.get('/m/:slug/flowers', async (req, res) => {
    const { p } = await loadVisible(req);
    const page = Math.min(200, Math.max(1, Number(req.query.page) || 1)); const per = 60;
    const rows = (await D.find(D.col('flowers').where('profile_id', '==', p.id).where('status', '==', 'published').orderBy('paid_at', 'desc').offset((page - 1) * per).limit(per))).map(asAuthor);
    res.html(layout(req, {
      title: `Flowers for ${p.name}`,
      bodyClass: `theme-${p.category}`,
      body: html`<section class="page">
        <p class="crumb"><a href="${p.url}">${p.name}</a></p>
        <h1>Flowers for ${p.plain}</h1>
        <p class="lede">${p.flower_count} ${p.flower_count === 1 ? 'person has' : 'people have'} laid a flower.</p>
        ${flowerList(rows)}
        ${pager(`${p.url}/flowers?`, page, p.flower_count, per)}
        <p><a class="btn btn--brass" href="${p.url}#lay-flower">Lay a flower</a></p>
      </section>`,
    }));
  });

  app.post('/tributes/:id/report', requireAuth, async (req, res) => {
    const ref = D.safeId(req.params.id) && D.col('tributes').doc(req.params.id);
    if (!ref) throw new HttpError(404, 'Tribute not found');
    const t = await D.db.runTransaction(async (tx) => {
      const cur = D.fromSnap(await tx.get(ref));
      if (!cur) return null;
      if (!(cur.reports || []).some((r) => r.user_id === req.user.id)) {
        tx.update(ref, { reported: true, reports: D.FieldValue.arrayUnion({ user_id: req.user.id, user_name: req.user.full_name, reason: str(req.body.reason, 300) || 'No reason given', at: nowISO() }) });
      }
      return cur;
    });
    if (!t) throw new HttpError(404, 'Tribute not found');
    req.flash('ok', 'Thanks. Our moderators will look at this tribute.');
    res.redirect(req.headers.referer && req.headers.referer.startsWith(config.baseUrl) ? req.headers.referer : `/m/${t.profile.slug}`);
  });

  app.get('/about', (req, res) => res.html(pages.about(req)));
  app.get('/how-it-works', (req, res) => res.html(pages.howItWorks(req)));
  app.get('/terms', (req, res) => res.html(pages.terms(req)));
  app.get('/charity', async (req, res) => {
    const [charities, stats, recent] = await Promise.all([
      D.find(D.col('charities')), D.getStats(), D.find(D.col('charity_disbursements').orderBy('created_at', 'desc').limit(20)),
    ]);
    const partners = charities.filter((c) => c.active).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    res.html(pages.charity(req, { partners, raised: stats.charity_total || 0, given: stats.charity_given || 0, recent }));
  });
}

module.exports = { register };
