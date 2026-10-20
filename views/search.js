// The memorial search page: filter panel, active filters and results.
const config = require('../lib/config');
const geo = require('../lib/geo');
const { SORTS, yearOptions, hasFilters } = require('../lib/search');
const { html } = require('../lib/util');
const { layout, stoneCard, pager, icon } = require('./layout');

const CAT_INTRO = {
  legend: 'People whose lives shaped communities and the nation, chosen by the tillwemeet team.',
  vvip: 'Memorials with a tribute video, a life timeline and the full order of service.',
  vip: 'Memorials with a solemn tone, a photo gallery and candles from visitors.',
  regular: 'Every life, remembered with a headstone, a story and tributes from those who loved them.',
};

/** Query string for a set of filters, leaving out empty ones and defaults. */
function qs(f, extra = {}) {
  const v = { ...f, ...extra };
  const out = {};
  if (v.q) out.q = v.q;
  if (v.year) { out.year = v.year; if (v.yearType === 'born') out.yearType = 'born'; }
  if (v.country) out.country = v.country;
  if (v.state) out.state = v.state;
  if (v.lga) out.lga = v.lga;
  if (v.sort && v.sort !== 'recent') out.sort = v.sort;
  if (v.page && v.page > 1) out.page = v.page;
  const s = new URLSearchParams(out).toString();
  return s ? `?${s}` : '';
}

const yearLabel = (f) => {
  if (!f.year) return '';
  const born = f.yearType === 'born';
  return f.year.endsWith('s') ? `${born ? 'Born' : 'Died'} in the ${f.year}` : `${born ? 'Born' : 'Died'} in ${f.year}`;
};

function activeChips(f, path) {
  const chips = [];
  if (f.q) chips.push([`Name: ${f.q}`, { q: '' }]);
  if (f.year) chips.push([yearLabel(f), { year: '', yearType: '' }]);
  if (f.lga) chips.push([f.lga, { lga: '' }]);
  if (f.state) chips.push([f.state, { state: '', lga: '' }]);
  if (f.country) chips.push([f.country, { country: '', state: '', lga: '' }]);
  if (!chips.length) return '';
  return html`<div class="chips" aria-label="Active filters">
    ${chips.map(([label, remove]) => html`<a class="chip-filter" href="${path}${qs(f, remove)}" aria-label="Remove filter: ${label}">${label}<span aria-hidden="true">${icon('close')}</span></a>`)}
    <a class="chips__clear" href="${path}${qs({ sort: f.sort })}">Clear all</a>
  </div>`;
}

function filterPanel(f, path, places) {
  const { decades, years } = yearOptions();
  const isNigeria = !f.country || f.country === 'Nigeria';
  return html`<form class="search-panel" id="search-panel" action="${path}" method="get" role="search" data-search-form>
    <div class="search-panel__name">
      <label for="sq">Name</label>
      <div class="suggest" data-suggest>
        <input id="sq" name="q" value="${f.q}" placeholder="First name, surname or nickname" autocomplete="off" maxlength="80"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="sq-list">
        <ul id="sq-list" class="suggest__list" role="listbox" hidden></ul>
      </div>
    </div>
    <fieldset class="search-panel__group">
      <legend>Year</legend>
      <div class="search-panel__row">
        <label class="sr" for="syt">Year of</label>
        <select id="syt" name="yearType">
          <option value="died" ${f.yearType !== 'born' ? 'selected' : ''}>Died in</option>
          <option value="born" ${f.yearType === 'born' ? 'selected' : ''}>Born in</option>
        </select>
        <label class="sr" for="sy">Year</label>
        <select id="sy" name="year" data-autosubmit>
          <option value="">Any year</option>
          <optgroup label="Decades">${decades.map((d) => html`<option value="${d}s" ${f.year === `${d}s` ? 'selected' : ''}>${d}s</option>`)}</optgroup>
          <optgroup label="Years">${years.map((y) => html`<option value="${y}" ${f.year === String(y) ? 'selected' : ''}>${y}</option>`)}</optgroup>
        </select>
      </div>
    </fieldset>
    <fieldset class="search-panel__group search-panel__place">
      <legend>Location</legend>
      <div class="search-panel__row search-panel__row--3">
        <label><span>Country</span>
          <select name="country" data-country-filter data-autosubmit>
            <option value="">Any country</option>
            ${geo.countries.map((c) => html`<option ${f.country === c ? 'selected' : ''}>${c}</option>`)}
          </select></label>
        <label><span>${isNigeria ? 'State' : 'State or region'}</span>
          <input name="state" value="${f.state}" list="s-states" placeholder="${isNigeria ? 'Any state' : 'Any region'}" maxlength="60" data-state-filter autocomplete="off"></label>
        <label><span>${isNigeria ? 'LGA' : 'County or district'}</span>
          <input name="lga" value="${f.lga}" list="s-lgas" placeholder="${f.state ? 'Any LGA' : 'Choose a state first, or type one'}" maxlength="80" data-lga-filter autocomplete="off"></label>
      </div>
      <datalist id="s-states">${places.states.map((s) => html`<option value="${s}">`)}</datalist>
      <datalist id="s-lgas">${places.lgas.map((s) => html`<option value="${s}">`)}</datalist>
    </fieldset>
    <div class="search-panel__foot">
      <label class="search-panel__sort"><span>Sort by</span>
        <select name="sort" data-autosubmit>${Object.entries(SORTS).map(([k, s]) => html`<option value="${k}" ${f.sort === k ? 'selected' : ''}>${s.label}</option>`)}</select></label>
      <button class="btn btn--ink">${icon('search')}<span>Search</span></button>
    </div>
  </form>`;
}

function searchPage(req, { category, f, rows, total, capped, page, perPage, places }) {
  const c = category ? config.categories[category] : null;
  const path = `/memorials${category ? `/${category}` : ''}`;
  const filtered = hasFilters(f);
  const title = c ? (category === 'legend' ? 'Legends' : `${c.name} memorials`) : 'Find a memorial';
  const countText = capped ? `Showing the first ${total} matches. Add another filter to narrow the search.`
    : total === 0 ? '' : `${total.toLocaleString()} ${total === 1 ? 'memorial' : 'memorials'}${filtered ? ' found' : ''}`;
  return layout(req, {
    title: filtered && f.q ? `Memorials matching “${f.q}”` : title,
    bodyClass: 'page-search',
    body: html`<section class="page">
      <header class="page__head">
        <h1>${title}</h1>
        <p class="lede">${c ? CAT_INTRO[category] : 'Search by name, the year someone was born or died, or where they came from.'}</p>
        <nav class="tabs" aria-label="Categories">
          <a href="/memorials${qs(f)}" ${!category ? 'aria-current="page"' : ''}>All</a>
          ${config.categoryOrder.map((k) => html`<a href="/memorials/${k}${qs(f)}" ${category === k ? 'aria-current="page"' : ''}>${config.categories[k].name}</a>`)}
        </nav>
      </header>
      <div class="search-layout" id="filters">
        <aside class="search-layout__filters">
          <button type="button" class="btn btn--ghost filter-toggle" data-filter-toggle aria-expanded="true" aria-controls="search-panel">
            ${icon('search')}<span>${(() => { const n = [f.q, f.year, f.country, f.state, f.lga].filter(Boolean).length; return n ? `Search and filters (${n} on)` : 'Search and filters'; })()}</span></button>
          ${filterPanel(f, path, places)}
        </aside>
        <div class="search-layout__results" aria-live="polite">
          ${activeChips(f, path)}
          ${countText ? html`<p class="result-count">${countText}</p>` : ''}
          ${rows.length ? html`<div class="stone-grid">${rows.map((p) => stoneCard(p))}</div>`
          : html`<div class="empty empty--search">
              <p><strong>No memorials match ${filtered ? 'these filters' : 'yet'}.</strong></p>
              ${filtered ? html`<ul class="empty__tips">
                ${f.q ? html`<li>Check the spelling, or search for the surname only.</li>` : ''}
                ${f.year && !f.year.endsWith('s') ? html`<li>Try the whole decade: <a href="${path}${qs(f, { year: `${f.year.slice(0, 3)}0s` })}">${yearLabel({ ...f, year: `${f.year.slice(0, 3)}0s` })}</a>.</li>` : ''}
                ${f.lga ? html`<li><a href="${path}${qs(f, { lga: '' })}">Search all of ${f.state || 'the state'}</a> instead of one LGA.</li>` : ''}
                ${category ? html`<li><a href="/memorials${qs(f)}">Search every category</a>.</li>` : ''}
              </ul>
              <a class="btn btn--ghost btn--sm" href="${path}">Clear all filters</a>` : html`<a class="btn btn--ink" href="/create">Create a memorial</a>`}
            </div>`}
          ${pager(`${path}${qs(f)}`, page, total, perPage)}
        </div>
      </div>
    </section>`,
  });
}

module.exports = { searchPage, CAT_INTRO, qs };
