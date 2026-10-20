const config = require('./config');
const D = require('./db');
const { displayName, plainName, computeAge, year, addDays, nowISO, slugify, searchTokens, queryWords } = require('./util');

function decorate(p) {
  if (!p) return p;
  return Object.assign(p, {
    name: displayName(p),
    plain: plainName(p),
    age: computeAge(p.dob, p.dod),
    years: `${year(p.dob)} – ${year(p.dod)}`,
    galleryList: p.gallery || [],
    timelineList: p.timeline || [],
    eventsList: p.service_events || [],
    tribute_count: p.tribute_count || 0,
    flower_count: p.flower_count || 0,
    cat: config.categories[p.category],
    photoUrl: p.photo ? `/media/${p.photo}` : '/static/img/portrait-placeholder.svg',
    url: `/m/${p.slug}`,
  });
}

/** Fields derived from the editable ones: search tokens and keys, years, and lower-case names for sorting. */
function derived(p) {
  const tokens = searchTokens(p.titles, p.first_name, p.middle_name, p.last_name, p.nickname);
  const { filterKeysOf } = require('./search');
  return {
    searchTokens: tokens,
    filterKeys: filterKeysOf(p, tokens),
    birth_year: Number(String(p.dob || '').slice(0, 4)) || null,
    death_year: Number(String(p.dod || '').slice(0, 4)) || null,
    first_name_lc: String(p.first_name || '').toLowerCase(),
    last_name_lc: String(p.last_name || '').toLowerCase(),
  };
}

/** Published memorials, filtered and sorted, with the total count for paging. See lib/search.js. */
async function listApproved({ category, limit = 30, offset = 0, q, state, country, lga, year, yearType, sort = 'recent' }) {
  const { searchMemorials, parseFilters } = require('./search');
  const f = parseFilters({ q, state, country, lga, year, yearType, sort });
  const { rows, total, capped } = await searchMemorials({ category, limit, offset, ...f });
  return { rows: rows.map(decorate), total, capped };
}

async function bySlug(slug) {
  const s = await D.getDoc('slugs', slug);
  return s ? decorate(await D.getDoc('profiles', s.profile_id)) : null;
}
async function byId(id) { return decorate(await D.getDoc('profiles', id)); }

/**
 * Creates a memorial with a unique slug (e.g. emeka-okafor-2026, then emeka-okafor-2026-2).
 * The slug is claimed with a document in "slugs" in the same transaction, so two memorials
 * can never share one.
 */
async function createProfile(data) {
  const base = slugify(`${data.first_name} ${data.last_name} ${String(data.dod).slice(0, 4)}`);
  const now = nowISO();
  const doc = {
    status: 'awaiting_payment', featured: 0, approved_at: null, approved_by: null, reject_reason: null,
    legend_since: null, previous_category: null, candles: 0, views: 0, tribute_count: 0, flower_count: 0,
    charity_raised: 0, creator_earned: 0, edit_count: 0, last_edit_at: null, listing_amount: null, listing_paid_at: null,
    last_revision: null, created_at: now, updated_at: now, ...data, ...derived(data),
  };
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const slugRef = D.col('slugs').doc(slug);
    const profRef = D.col('profiles').doc();
    try {
      await D.db.runTransaction(async (tx) => {
        if ((await tx.get(slugRef)).exists) throw Object.assign(new Error('slug taken'), { taken: true });
        tx.create(slugRef, { profile_id: profRef.id });
        tx.create(profRef, { ...doc, slug });
        tx.update(D.col('users').doc(data.creator_id), { memorial_count: D.inc(1) });
      });
      return { id: profRef.id, slug };
    } catch (e) {
      if (!e.taken && !D.isAlreadyExists(e)) throw e;
    }
  }
  throw new Error('Could not find a free web address for this memorial');
}

/**
 * Edit rule: the first edit can happen at any time. After that, each edit
 * opens 90 days after the previous one.
 */
function editWindow(p) {
  if (!p.edit_count || !p.last_edit_at) return { allowed: true, first: true };
  const next = addDays(p.last_edit_at, config.editCooldownDays);
  return { allowed: next <= nowISO(), first: false, nextAt: next };
}

async function pendingRevision(profileId) {
  return D.first(D.col('revisions').where('profile_id', '==', profileId).where('status', '==', 'pending'));
}

module.exports = { decorate, derived, listApproved, bySlug, byId, createProfile, editWindow, pendingRevision };
