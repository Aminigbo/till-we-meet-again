// Memorial search: by name, by year (of death or birth, exact year or decade) and by location
// (country, state/region, LGA/county), within a category, sorted several ways.
//
// How it works on Firestore: every memorial stores "filterKeys", e.g.
//   c:nigeria  s:lagos  l:ikeja  d:2024  dd:2020  b:1951  bd:1950  n:oko  n:okon ...
// A search sends the most selective key to Firestore (one array-contains filter) and checks
// the rest here. This needs only a handful of composite indexes for every combination of
// filters, instead of one index per combination.
const config = require('./config');
const D = require('./db');
const geo = require('./geo');
const { queryWords } = require('./util');

const SCAN_LIMIT = 1000; // most memorials checked for a multi-filter search
const SORTS = {
  recent: { label: 'Recently added', order: [['featured', 'desc'], ['approved_at', 'desc']] },
  died: { label: 'Date of death, newest first', order: [['dod', 'desc'], ['approved_at', 'desc']] },
  tributes: { label: 'Most tributes', order: [['tribute_count', 'desc'], ['approved_at', 'desc']] },
  flowers: { label: 'Most flowers', order: [['flower_count', 'desc'], ['approved_at', 'desc']] },
  name: { label: 'Surname A–Z', order: [['last_name_lc', 'asc'], ['first_name_lc', 'asc']] },
};

/** Normalises a place name for matching: "Obio/Akpor" and "obio-akpor" both become "obioakpor". */
const placeKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

/** The search keys stored on a memorial. */
function filterKeysOf(p, nameTokens) {
  const keys = new Set();
  if (p.country) keys.add(`c:${placeKey(p.country)}`);
  if (p.state) keys.add(`s:${placeKey(p.state)}`);
  if (p.lga) keys.add(`l:${placeKey(p.lga)}`);
  const dy = Number(String(p.dod || '').slice(0, 4)); const by = Number(String(p.dob || '').slice(0, 4));
  if (dy) { keys.add(`d:${dy}`); keys.add(`dd:${Math.floor(dy / 10) * 10}`); }
  if (by) { keys.add(`b:${by}`); keys.add(`bd:${Math.floor(by / 10) * 10}`); }
  for (const t of nameTokens || []) keys.add(`n:${t}`);
  return [...keys];
}

/** Reads and cleans search parameters from a query string. */
function parseFilters(query) {
  const s = (v, n) => String(Array.isArray(v) ? v[0] : (v ?? '')).trim().slice(0, n);
  const f = {
    q: s(query.q, 80), country: s(query.country, 60), state: s(query.state, 60), lga: s(query.lga, 80),
    year: s(query.year, 5), yearType: query.yearType === 'born' ? 'born' : 'died',
    sort: SORTS[query.sort] ? query.sort : 'recent',
  };
  // Older links used ?state= for a country too
  if (f.state && !f.country && geo.countries.includes(f.state) && f.state !== 'Niger') { f.country = f.state; f.state = ''; }
  const thisYear = new Date().getFullYear();
  if (!/^\d{4}s?$/.test(f.year) || Number(f.year.slice(0, 4)) < 1850 || Number(f.year.slice(0, 4)) > thisYear) f.year = '';
  if (/s$/.test(f.year)) f.year = `${Math.floor(Number(f.year.slice(0, 4)) / 10) * 10}s`;
  return f;
}

/** Keys for a search, most selective first. */
function keysForSearch(f) {
  const keys = [];
  if (f.lga) keys.push(`l:${placeKey(f.lga)}`);
  const yt = f.yearType === 'born' ? 'b' : 'd';
  if (f.year && !f.year.endsWith('s')) keys.push(`${yt}:${f.year}`);
  for (const w of queryWords(f.q)) keys.push(`n:${w}`);
  if (f.state) keys.push(`s:${placeKey(f.state)}`);
  if (f.year && f.year.endsWith('s')) keys.push(`${yt}d:${f.year.slice(0, 4)}`);
  if (f.country) keys.push(`c:${placeKey(f.country)}`);
  return [...new Set(keys.filter((k) => !/:$/.test(k)))];
}

const hasFilters = (f) => !!(f.q || f.country || f.state || f.lga || f.year);

/**
 * Search published memorials. Returns { rows, total, capped } where capped means more than
 * SCAN_LIMIT memorials matched the first filter, so the total is a lower bound.
 */
async function searchMemorials({ category, limit = 30, offset = 0, ...filters }) {
  const f = { ...parseFilters({}), ...filters };
  const keys = keysForSearch(f);
  let base = D.col('profiles').where('status', '==', 'approved');
  if (category) base = base.where('category', '==', category);
  const ordered = (q) => (SORTS[f.sort] || SORTS.recent).order.reduce((qq, [field, dir]) => qq.orderBy(field, dir), q);

  if (keys.length <= 1) {
    const q = keys.length ? base.where('filterKeys', 'array-contains', keys[0]) : base;
    const [rows, total] = await Promise.all([D.find(ordered(q).offset(offset).limit(limit)), D.count(q)]);
    return { rows, total, capped: false };
  }
  // Several filters: Firestore narrows by the most selective one, the rest are checked here.
  // Results are cached briefly so paging through them doesn't repeat the scan.
  const cacheKey = `search:${category || ''}:${f.sort}:${keys.join(',')}`;
  const { matches, capped } = await D.cached(cacheKey, 60000, async () => {
    const scanned = await D.find(ordered(base.where('filterKeys', 'array-contains', keys[0])).limit(SCAN_LIMIT));
    const rest = keys.slice(1);
    return { matches: scanned.filter((p) => rest.every((k) => (p.filterKeys || []).includes(k))), capped: scanned.length === SCAN_LIMIT };
  });
  return { rows: matches.slice(offset, offset + limit), total: matches.length, capped };
}

/** Up to 6 names for the search box as someone types. */
async function suggest(q) {
  const words = queryWords(q);
  if (!words.length) return [];
  return D.cached(`suggest:${words.join(' ')}`, 60000, async () => {
    const rows = await D.find(D.col('profiles').where('status', '==', 'approved').where('filterKeys', 'array-contains', `n:${words[0]}`)
      .orderBy('featured', 'desc').orderBy('approved_at', 'desc').limit(40));
    return rows.filter((p) => words.every((w) => p.filterKeys.includes(`n:${w}`))).slice(0, 6);
  });
}

/**
 * Place names to suggest in the filters: states for a country (Nigeria's 36 states and the FCT are built in),
 * and LGAs/counties for a state, taken from published memorials. Cached for 10 minutes.
 */
async function places({ country, state }) {
  return D.cached(`places:${placeKey(country)}:${placeKey(state)}`, 600000, async () => {
    const out = { states: [], lgas: [] };
    const distinct = (rows, field) => [...new Map(rows.filter((r) => r[field]).map((r) => [placeKey(r[field]), r[field]])).values()].sort((a, b) => a.localeCompare(b));
    if (country === 'Nigeria' || !country) out.states = [...geo.nigeriaStates];
    if (country && country !== 'Nigeria') {
      const rows = await D.find(D.col('profiles').where('status', '==', 'approved').where('filterKeys', 'array-contains', `c:${placeKey(country)}`).limit(SCAN_LIMIT));
      out.states = distinct(rows, 'state');
    }
    if (state) {
      let rows = await D.find(D.col('profiles').where('status', '==', 'approved').where('filterKeys', 'array-contains', `s:${placeKey(state)}`).limit(SCAN_LIMIT));
      if (country) rows = rows.filter((r) => placeKey(r.country) === placeKey(country));
      out.lgas = distinct(rows, 'lga');
    }
    return out;
  });
}

/** Years and decades offered in the year filter, newest first. */
function yearOptions() {
  const now = new Date().getFullYear();
  const decades = []; for (let d = Math.floor(now / 10) * 10; d >= 1900; d -= 10) decades.push(d);
  const years = []; for (let y = now; y >= 1900; y--) years.push(y);
  return { decades, years };
}

module.exports = { SORTS, SCAN_LIMIT, placeKey, filterKeysOf, parseFilters, keysForSearch, hasFilters, searchMemorials, suggest, places, yearOptions };
