// Firestore data access helpers.
//
// Collections (see README, "Data model"):
//   users, user_emails (unique email -> uid), profiles, slugs (unique slug -> profile),
//   tributes (id = profileId_userId, so one per person per memorial), flowers, payments (id = reference),
//   ledger, withdrawals, charities, charity_disbursements, tones, revisions, candles (id = profileId_userId),
//   sessions, settings, audit_log, stats (running totals), stats_daily
const config = require('./config');
const { db, FieldValue, mode, isAlreadyExists } = require('./firestore');
const { nowISO } = require('./util');

const col = (name) => db.collection(name);

/** Firestore document ids from URLs: reject anything that isn't a plain id. */
function safeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id) ? id : null;
}

const fromSnap = (s) => (s && s.exists ? { id: s.id, ...s.data() } : null);
const fromQuery = (qs) => qs.docs.map((d) => ({ id: d.id, ...d.data() }));

async function getDoc(collection, id) {
  const sid = safeId(id);
  return sid ? fromSnap(await col(collection).doc(sid).get()) : null;
}
async function find(query) { return fromQuery(await query.get()); }
async function first(query) { const r = await query.limit(1).get(); return r.empty ? null : { id: r.docs[0].id, ...r.docs[0].data() }; }
async function count(query) { return (await query.count().get()).data().count; }

/** Load many documents by id in one round trip (missing ones are skipped). */
async function getMany(collection, ids) {
  const unique = [...new Set(ids.map(safeId).filter(Boolean))];
  if (!unique.length) return new Map();
  const snaps = await db.getAll(...unique.map((id) => col(collection).doc(id)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, { id: s.id, ...s.data() }]));
}

// ---------- Settings (prices), cached in memory and refreshed every minute ----------
let settings = {};
async function loadSettings() {
  try { const s = await col('settings').doc('prices').get(); settings = s.exists ? s.data() : {}; } catch (e) { console.error('settings', e.message); }
}
setInterval(loadSettings, 60000).unref();

function prices(cat) {
  const c = config.categories[cat];
  const pick = (k, d) => (settings[k] !== undefined && settings[k] !== null ? Number(settings[k]) : d);
  return {
    listingFee: c.listingFee === null ? null : pick(`listing_${cat}`, c.listingFee),
    tributeFee: pick(`tribute_${cat}`, c.tributeFee),
    flowerFee: pick(`flower_${cat}`, c.flowerFee),
  };
}
async function savePrices(values) {
  await col('settings').doc('prices').set(values, { merge: true });
  await loadSettings();
}

// ---------- Audit log ----------
async function audit(actor, action, target, detail) {
  await col('audit_log').add({
    actor_id: actor ? actor.id : null, actor_name: actor ? actor.full_name : 'System',
    action, target: target || null, detail: detail === undefined || detail === null ? null : String(detail).slice(0, 500), created_at: nowISO(),
  });
}

// ---------- Running totals ----------
const statsRef = () => col('stats').doc('global');
const inc = (n) => FieldValue.increment(n);
/** Adds to the platform totals inside a transaction or batch: bumpStats(tx, { charity_total: 400 }) */
function bumpStats(writer, deltas) {
  writer.set(statsRef(), Object.fromEntries(Object.entries(deltas).map(([k, v]) => [k, inc(v)])), { merge: true });
}
async function getStats() { return (await statsRef().get()).data() || {}; }

// Simple in-memory cache for pages that many visitors load (homepage sections)
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  return value;
}
const bustCache = () => cache.clear();

module.exports = {
  db, FieldValue, mode, isAlreadyExists, col, safeId, fromSnap, fromQuery, getDoc, find, first, count, getMany,
  loadSettings, prices, savePrices, audit, bumpStats, getStats, statsRef, inc, cached, bustCache, now: nowISO,
};
