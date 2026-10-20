// Creating, paying for, editing and upgrading memorials.
const config = require('../lib/config');
const D = require('../lib/db');
const P = require('../lib/profiles');
const { saveUpload, removeUpload, videoDuration } = require('../lib/media');
const { startPayment } = require('../lib/payments');
const { HttpError } = require('../lib/app');
const { str, isoDate, encrypt, nowISO, todayISO } = require('../lib/util');
const { memorialForm } = require('../views/memorial-form');
const { requireAuth } = require('./auth');

const EDITABLE = ['titles', 'first_name', 'middle_name', 'last_name', 'nickname', 'gender', 'dob', 'dod', 'country', 'state', 'lga',
  'place_of_death', 'burial_date', 'burial_place', 'biography', 'epitaph', 'survivors', 'tone_id', 'timeline', 'service_events',
  'photo', 'video', 'video_duration', 'gallery'];

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const rank = (cat) => config.categories[cat].rank;

/** Read and validate the memorial form. Files are saved only when the text fields pass. */
async function readForm(req, { isEdit, existing }) {
  const b = req.body; const errors = {};
  const category = isEdit ? existing.category : str(b.category, 10);
  if (!isEdit && !config.selectableCategories.includes(category)) errors.category = 'Choose Regular, VIP or VVIP.';
  const cat = config.categories[category] || config.categories.regular;

  const d = {
    titles: str(b.titles, 80).split(',').map((t) => t.trim()).filter(Boolean).join(', '),
    first_name: str(b.first_name, 60), middle_name: str(b.middle_name, 60), last_name: str(b.last_name, 60),
    nickname: str(b.nickname, 60), gender: ['Female', 'Male'].includes(b.gender) ? b.gender : '',
    dob: isoDate(str(b.dob, 10)), dod: isoDate(str(b.dod, 10)),
    country: str(b.country, 60), state: str(b.state, 60), lga: str(b.lga, 80),
    place_of_death: str(b.place_of_death, 120), burial_date: isoDate(str(b.burial_date, 10)), burial_place: str(b.burial_place, 160),
    biography: str(b.biography, 12000), epitaph: rank(category) >= 2 ? str(b.epitaph, 140) : '',
    survivors: rank(category) >= 3 ? str(b.survivors, 1500) : '',
    tone_id: null,
  };
  if (cat.tone && b.tone_id) {
    const t = await D.getDoc('tones', String(b.tone_id));
    d.tone_id = t && t.active ? t.id : null;
  }
  // VVIP: timeline and order of service
  const tlY = asList(b.tl_year); const tlT = asList(b.tl_text);
  d.timeline = rank(category) >= 3 ? tlY.map((y, i) => ({ year: str(y, 4), text: str(tlT[i], 160) })).filter((t) => /^\d{4}$/.test(t.year) && t.text).sort((a, b2) => a.year - b2.year) : [];
  const evT = asList(b.ev_title);
  d.service_events = rank(category) >= 3 ? evT.map((t, i) => ({
    title: str(t, 80), date: isoDate(str(asList(b.ev_date)[i], 10)) || '', time: /^\d{2}:\d{2}$/.test(asList(b.ev_time)[i] || '') ? asList(b.ev_time)[i] : '', venue: str(asList(b.ev_venue)[i], 160),
  })).filter((e) => e.title && (e.date || e.venue)) : [];

  if (d.first_name.length < 2) errors.first_name = 'Enter the first name.';
  if (d.last_name.length < 2) errors.last_name = 'Enter the surname.';
  if (!d.dob) errors.dob = 'Enter the date of birth.';
  if (!d.dod) errors.dod = 'Enter the date of death.';
  if (d.dob && d.dod && d.dob > d.dod) errors.dod = 'The date of death must be after the date of birth.';
  if (d.dod && d.dod > todayISO()) errors.dod = 'The date of death can’t be in the future.';
  if (d.dob && d.dob < '1850-01-01') errors.dob = 'Check the year of birth.';
  if (!d.country) errors.country = 'Choose a country.';
  if (!d.state) errors.state = 'Enter the state or region.';
  if (!d.lga) errors.lga = 'Enter the local government area or county.';
  if (d.biography.length < 80) errors.biography = 'Write at least 80 characters about their life.';

  let v = {};
  if (!isEdit) {
    v = {
      death_cert_number: str(b.death_cert_number, 60), death_cert_authority: str(b.death_cert_authority, 120), cause_of_death: str(b.cause_of_death, 120),
      uploader_relationship: str(b.uploader_relationship, 60), uploader_nin: str(b.uploader_nin, 11).replace(/\D/g, ''),
      uploader_phone: str(b.uploader_phone, 20), uploader_address: str(b.uploader_address, 200),
      next_of_kin_name: str(b.next_of_kin_name, 120), next_of_kin_phone: str(b.next_of_kin_phone, 20),
    };
    if (!v.death_cert_number) errors.death_cert_number = 'Enter the certificate number.';
    if (!v.death_cert_authority) errors.death_cert_authority = 'Enter who issued the certificate.';
    if (!v.uploader_relationship) errors.uploader_relationship = 'Choose your relationship.';
    if (!/^\d{11}$/.test(v.uploader_nin)) errors.uploader_nin = 'Your NIN has 11 digits.';
    if (!/^\+?[0-9 ()-]{7,20}$/.test(v.uploader_phone)) errors.uploader_phone = 'Enter a valid phone number.';
    if (v.uploader_address.length < 8) errors.uploader_address = 'Enter your address.';
    if (v.next_of_kin_name.length < 3) errors.next_of_kin_name = 'Enter the name of another family member.';
    if (!/^\+?[0-9 ()-]{7,20}$/.test(v.next_of_kin_phone)) errors.next_of_kin_phone = 'Enter a valid phone number.';
    if (v.next_of_kin_phone && v.next_of_kin_phone === v.uploader_phone) errors.next_of_kin_phone = 'Use a different person’s number from yours.';
    if (!b.attest) errors.attest = 'Confirm the statement to continue.';
    if (!req.files.photo) errors.photo = 'Add a portrait photo.';
    if (!req.files.death_cert) errors.death_cert = 'Attach the death certificate.';
    if (!req.files.uploader_photo) errors.uploader_photo = 'Add a photo of yourself.';
  }

  // Gallery limits
  let gallery = isEdit ? [...existing.galleryList] : [];
  const removeG = asList(b.remove_gallery);
  gallery = gallery.filter((g) => !removeG.includes(g));
  const newG = cat.gallery ? (req.files.gallery || []) : [];
  if (gallery.length + newG.length > cat.gallery && cat.gallery) errors.gallery = `${cat.name} memorials hold up to ${cat.gallery} photos. Choose fewer.`;

  if (Object.keys(errors).length) return { errors, d, v };

  // Save files
  const saved = []; // [name, visibility] for clean-up on failure
  const keep = (name, vis) => { if (name) saved.push([name, vis]); return name; };
  try {
    const one = (k) => (req.files[k] || [])[0];
    if (one('photo')) d.photo = keep(await saveUpload(one('photo'), { kinds: ['image'], maxMB: 5, visibility: 'public', label: 'Portrait photo' }), 'public');
    if (!isEdit) {
      v.death_cert = keep(await saveUpload(one('death_cert'), { kinds: ['pdf', 'image'], maxMB: 10, visibility: 'private', label: 'Death certificate' }), 'private');
      v.uploader_photo = keep(await saveUpload(one('uploader_photo'), { kinds: ['image'], maxMB: 5, visibility: 'private', label: 'Your photo' }), 'private');
      if (one('uploader_id_doc')) v.uploader_id_doc = keep(await saveUpload(one('uploader_id_doc'), { kinds: ['pdf', 'image'], maxMB: 10, visibility: 'private', label: 'Photo ID' }), 'private');
    }
    for (const g of newG) gallery.push(keep(await saveUpload(g, { kinds: ['image'], maxMB: 5, visibility: 'public', label: 'Gallery photo' }), 'public'));
    d.gallery = gallery;
    if (cat.video && one('video')) {
      const dur = await videoDuration(one('video').data);
      if (dur === null) d.video_duration = null; // ffprobe not installed: browser check only
      else if (!(dur >= config.videoMinSec - 0.5 && dur <= config.videoMaxSec + 0.5)) {
        throw new HttpError(400, `The video is ${Number.isFinite(dur) ? Math.round(dur) + ' seconds' : 'unreadable'}. It must be ${config.videoMinSec}–${config.videoMaxSec} seconds.`);
      } else d.video_duration = dur;
      d.video = keep(await saveUpload(one('video'), { kinds: ['video'], maxMB: 50, visibility: 'public', label: 'Tribute video' }), 'public');
    }
  } catch (e) {
    await Promise.all(saved.map(([n, vis]) => removeUpload(n, vis)));
    if (e.status === 400) {
      const key = /video/i.test(e.message) ? 'video' : /gallery/i.test(e.message) ? 'gallery' : /certificate/i.test(e.message) ? 'death_cert' : /Your photo/.test(e.message) ? 'uploader_photo' : /Photo ID/.test(e.message) ? 'uploader_id_doc' : 'photo';
      return { errors: { [key]: e.message }, d, v };
    }
    throw e;
  }
  return { errors: {}, d, v, category, removedGallery: removeG, saved };
}

async function ownMemorial(req) {
  const p = await P.byId(req.params.id);
  if (!p || (p.creator_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Memorial not found');
  return p;
}

const norm = (x) => (x === null || x === undefined ? '' : x);
const differs = (a, b) => JSON.stringify(norm(a)) !== JSON.stringify(norm(b));

/** The fields to write for a set of changes (search tokens follow name changes). */
function changeSet(profile, changes) {
  const out = {};
  for (const k of EDITABLE) if (changes[k] !== undefined) out[k] = changes[k];
  return { ...out, ...P.derived({ ...profile, ...out }), updated_at: nowISO() };
}

/** Apply a set of field changes to a profile, then delete files that were replaced. */
async function applyChanges(profile, changes, removedGallery = []) {
  await D.col('profiles').doc(profile.id).update(changeSet(profile, changes));
  await cleanupReplaced(profile, changes, removedGallery);
  D.bustCache();
}
async function cleanupReplaced(profile, changes, removedGallery = []) {
  const gone = [...removedGallery];
  if (changes.photo && profile.photo && changes.photo !== profile.photo) gone.push(profile.photo);
  if (changes.video && profile.video && changes.video !== profile.video) gone.push(profile.video);
  await Promise.all(gone.map((g) => removeUpload(g, 'public')));
}

const toneList = () => D.cached('tones', 60000, async () => (await D.find(D.col('tones'))).filter((t) => t.active).sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title)));

function register(app) {
  app.get('/create', requireAuth, async (req, res) => {
    const pre = config.selectableCategories.includes(req.query.category) ? req.query.category : 'regular';
    res.html(memorialForm(req, { mode: 'create', values: { category: pre }, action: '/create', tones: await toneList() }));
  });

  app.post('/create', requireAuth, async (req, res) => {
    req.rateLimit('create', 20, 60 * 60 * 1000);
    const r = await readForm(req, { isEdit: false });
    if (Object.keys(r.errors).length) {
      return res.html(memorialForm(req, { mode: 'create', values: { ...req.body, ...r.d, timelineList: r.d.timeline, eventsList: r.d.service_events }, errors: r.errors, action: '/create', tones: await toneList() }), 400);
    }
    const { d, v } = r;
    const { id } = await P.createProfile({
      creator_id: req.user.id, creator_name: req.user.full_name, category: r.category,
      titles: d.titles, first_name: d.first_name, middle_name: d.middle_name, last_name: d.last_name, nickname: d.nickname, gender: d.gender,
      dob: d.dob, dod: d.dod, country: d.country, state: d.state, lga: d.lga, place_of_death: d.place_of_death, cause_of_death: v.cause_of_death,
      burial_date: d.burial_date, burial_place: d.burial_place, biography: d.biography, epitaph: d.epitaph, survivors: d.survivors,
      photo: d.photo, tone_id: d.tone_id, video: d.video || null, video_duration: d.video_duration ?? null,
      gallery: d.gallery, timeline: d.timeline, service_events: d.service_events,
      death_cert: v.death_cert, death_cert_number: v.death_cert_number, death_cert_authority: v.death_cert_authority,
      uploader_relationship: v.uploader_relationship, uploader_nin_enc: encrypt(v.uploader_nin), uploader_nin_last4: v.uploader_nin.slice(-4),
      uploader_photo: v.uploader_photo, uploader_id_doc: v.uploader_id_doc || null, uploader_phone: v.uploader_phone, uploader_address: v.uploader_address,
      next_of_kin_name: v.next_of_kin_name, next_of_kin_phone: v.next_of_kin_phone, attested_at: nowISO(),
    });
    await D.audit(req.user, 'memorial.create', `profile:${id}`, r.category);
    res.redirect(await startPayment({ user: req.user, purpose: 'listing', targetId: id, amount: D.prices(r.category).listingFee, successPath: `/account/memorials/${id}?paid=1`, cancelPath: `/account/memorials/${id}` }));
  });

  // Pay (or retry paying) a listing fee
  app.post('/account/memorials/:id/pay', requireAuth, async (req, res) => {
    const p = await ownMemorial(req);
    if (p.status !== 'awaiting_payment') { req.flash('info', 'This memorial is already paid for.'); return res.redirect(`/account/memorials/${p.id}`); }
    res.redirect(await startPayment({ user: req.user, purpose: 'listing', targetId: p.id, amount: D.prices(p.category).listingFee, successPath: `/account/memorials/${p.id}?paid=1`, cancelPath: `/account/memorials/${p.id}` }));
  });

  // Upgrade category: pay the difference in listing fees
  app.post('/account/memorials/:id/upgrade', requireAuth, async (req, res) => {
    const p = await ownMemorial(req);
    const to = req.body.to;
    if (!['vip', 'vvip'].includes(to) || p.category === 'legend' || rank(to) <= rank(p.category)) throw new HttpError(400, 'That upgrade isn’t available.');
    const back = { successPath: `/account/memorials/${p.id}?paid=1`, cancelPath: `/account/memorials/${p.id}` };
    if (p.status === 'awaiting_payment') {
      await D.col('profiles').doc(p.id).update({ category: to });
      return res.redirect(await startPayment({ user: req.user, purpose: 'listing', targetId: p.id, amount: D.prices(to).listingFee, ...back }));
    }
    const diff = D.prices(to).listingFee - D.prices(p.category).listingFee;
    res.redirect(await startPayment({ user: req.user, purpose: 'upgrade', targetId: p.id, amount: diff, meta: { from: p.category, to }, ...back }));
  });

  app.get('/account/memorials/:id/edit', requireAuth, async (req, res) => {
    const p = await ownMemorial(req);
    if (p.status === 'approved') {
      const w = P.editWindow(p);
      if (!w.allowed) { req.flash('info', 'This memorial can’t be edited yet. See the date below.'); return res.redirect(`/account/memorials/${p.id}`); }
      if (await P.pendingRevision(p.id)) { req.flash('info', 'Your last changes are still being reviewed.'); return res.redirect(`/account/memorials/${p.id}`); }
    }
    if (p.status === 'suspended') throw new HttpError(403, 'This memorial is suspended. Contact support to restore it.');
    res.html(memorialForm(req, { mode: 'edit', p, action: `/account/memorials/${p.id}/edit`, tones: await toneList() }));
  });

  app.post('/account/memorials/:id/edit', requireAuth, async (req, res) => {
    const p = await ownMemorial(req);
    if (p.status === 'suspended') throw new HttpError(403, 'This memorial is suspended.');
    const live = p.status === 'approved';
    if (live) {
      if (!P.editWindow(p).allowed) throw new HttpError(403, 'This memorial can’t be edited yet.');
      if (await P.pendingRevision(p.id)) throw new HttpError(409, 'Your last changes are still being reviewed.');
    }
    const r = await readForm(req, { isEdit: true, existing: p });
    if (Object.keys(r.errors).length) {
      return res.html(memorialForm(req, { mode: 'edit', p, values: { ...r.d, timelineList: r.d.timeline, eventsList: r.d.service_events }, errors: r.errors, action: `/account/memorials/${p.id}/edit`, tones: await toneList() }), 400);
    }
    const changes = {};
    for (const k of EDITABLE) if (r.d[k] !== undefined && differs(r.d[k], p[k])) changes[k] = r.d[k];
    if (!Object.keys(changes).length) { req.flash('info', 'Nothing changed, so nothing was sent.'); return res.redirect(`/account/memorials/${p.id}`); }

    if (!live) {
      // Not yet published: changes apply straight away and don't count as an edit.
      const resubmit = p.status === 'rejected' && p.listing_paid_at ? { status: 'pending_review', reject_reason: null } : {};
      await D.col('profiles').doc(p.id).update({ ...changeSet(p, changes), ...resubmit });
      await cleanupReplaced(p, changes, r.removedGallery);
      req.flash('ok', p.status === 'rejected' ? 'Saved and sent back for review.' : 'Saved.');
    } else {
      // Live: the change waits for review. The edit allowance is used now, inside a transaction,
      // so two edits sent at the same time can't both get through.
      const profRef = D.col('profiles').doc(p.id);
      try {
        await D.db.runTransaction(async (tx) => {
          const cur = D.fromSnap(await tx.get(profRef));
          const pending = await tx.get(D.col('revisions').where('profile_id', '==', p.id).where('status', '==', 'pending'));
          if (!P.editWindow(cur).allowed || !pending.empty) throw new HttpError(409, 'Your last changes are still being reviewed, or the next edit isn’t open yet.');
          tx.create(D.col('revisions').doc(), {
            profile_id: p.id, profile_name: `${p.first_name} ${p.last_name}`, profile_slug: p.slug, user_id: req.user.id, user_name: req.user.full_name,
            changes, removedGallery: r.removedGallery, prev: { edit_count: cur.edit_count || 0, last_edit_at: cur.last_edit_at || null },
            status: 'pending', admin_note: null, created_at: nowISO(), reviewed_at: null,
          });
          tx.update(profRef, { edit_count: D.inc(1), last_edit_at: nowISO() });
        });
      } catch (e) {
        await Promise.all(r.saved.map(([n, vis]) => removeUpload(n, vis)));
        throw e;
      }
      req.flash('ok', 'Your changes were sent for review. The memorial stays live in the meantime.');
    }
    await D.audit(req.user, 'memorial.edit', `profile:${p.id}`, Object.keys(changes).join(','));
    res.redirect(`/account/memorials/${p.id}`);
  });
}

module.exports = { register, applyChanges, changeSet, cleanupReplaced, ownMemorial, toneList };
