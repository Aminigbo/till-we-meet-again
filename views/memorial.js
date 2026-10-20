const config = require('../lib/config');
const db = require('../lib/db'); // prices() reads an in-memory cache
const { toneUrl, html, raw, naira, fmtDate, fmtDateTime } = require('../lib/util');
const FL = require('../lib/flowers');
const { layout, csrf, shareLinks, icon } = require('./layout');

function paragraphs(text) {
  return String(text || '').split(/\n{2,}|\r\n\r\n/).map((p) => p.trim()).filter(Boolean).map((p) => html`<p>${p}</p>`);
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Ikeja, Lagos, Nigeria", each part linking to a search for memorials from that place. */
function placeLinks(p) {
  const parts = [];
  const enc = (o) => new URLSearchParams(o).toString();
  if (p.lga) parts.push(html`<a class="fact-link" href="/memorials?${enc({ country: p.country, state: p.state, lga: p.lga })}">${p.lga}</a>`);
  if (p.state) parts.push(html`<a class="fact-link" href="/memorials?${enc({ country: p.country, state: p.state })}">${p.state}</a>`);
  if (p.country) parts.push(html`<a class="fact-link" href="/memorials?${enc({ country: p.country })}">${p.country}</a>`);
  return parts.map((x, i) => html`${i ? ', ' : ''}${x}`);
}

function memorialPage(req, p, { tributes, myTribute, litCandle, tone, isOwner, preview, charityRaised = 0, flowers = [], pendingFlower }) {
  const rank = p.cat.rank;
  const signedIn = !!req.user;
  const url = `${config.baseUrl}${p.url}`;
  const shareText = `In loving memory of ${p.name} (${p.years}). Visit the memorial and leave a tribute on tillwemeet:`;
  const fee = db.prices(p.category).tributeFee;
  const place = [p.lga, p.state, p.country].filter(Boolean).join(', ');
  const flowerFee = db.prices(p.category).flowerFee;
  const maxWords = p.cat.tributeWords;
  // Drafts kept after a word-limit error
  const tDraft = req.session.tributeDraft && req.session.tributeDraft.profile === p.id ? req.session.tributeDraft : null;
  const fDraft = req.session.flowerDraft && req.session.flowerDraft.profile === p.id ? req.session.flowerDraft : null;
  delete req.session.tributeDraft; delete req.session.flowerDraft;
  const draftFlower = fDraft || pendingFlower || {};

  const hero = html`<section class="memorial-hero">
    <div class="memorial-hero__in">
      <div class="headstone headstone--${p.category}">
        ${p.category === 'legend' ? html`<span class="headstone__laurel">${icon('laurel')}</span>` : ''}
        <div class="headstone__photo"><img src="${p.photoUrl}" alt="Portrait of ${p.plain}"></div>
        ${p.titles ? html`<p class="headstone__titles">${p.titles.split(',').map((t) => t.trim()).join(' ')}</p>` : ''}
        <h1 class="headstone__name">${p.first_name} ${p.middle_name || ''} ${p.last_name}</h1>
        ${p.nickname ? html`<p class="headstone__aka">fondly called ${p.nickname}</p>` : ''}
        <p class="headstone__years">${p.years}</p>
        ${p.epitaph && rank >= 2 ? html`<p class="headstone__epitaph">${p.epitaph}</p>` : ''}
        ${rank >= 3 ? html`<p class="seal">${icon('seal')}<span>${p.category === 'legend' ? 'Honoured as a Legend by tillwemeet' : 'Verified by the family and tillwemeet'}</span></p>` : ''}
      </div>
      <dl class="facts">
        <div><dt>Born</dt><dd>${fmtDate(p.dob)}</dd></div>
        <div><dt>Died</dt><dd>${fmtDate(p.dod).replace(/ \d{4}$/, '')} <a class="fact-link" href="/memorials?year=${p.dod.slice(0, 4)}" title="Others who died in ${p.dod.slice(0, 4)}">${p.dod.slice(0, 4)}</a></dd></div>
        <div><dt>Age</dt><dd>${p.age ? p.age.label : ''}</dd></div>
        <div><dt>From</dt><dd>${placeLinks(p)}</dd></div>
        <div class="facts__counts"><dt class="sr">Tributes and flowers</dt><dd><a href="#tributes">${icon('quill')}<strong>${p.tribute_count}</strong> ${p.tribute_count === 1 ? 'tribute' : 'tributes'}</a><a href="#flowers">${icon('flower')}<strong>${p.flower_count}</strong> ${p.flower_count === 1 ? 'flower' : 'flowers'}</a></dd></div>
        ${p.burial_date || p.burial_place ? html`<div><dt>Laid to rest</dt><dd>${[p.burial_date ? fmtDate(p.burial_date) : '', p.burial_place].filter(Boolean).join(', ')}</dd></div>` : ''}
      </dl>
      <div class="memorial-hero__actions">
        <a class="btn btn--brass" href="#tribute-form">Leave a tribute</a>
        <a class="btn btn--candle" href="#lay-flower">${icon('flower')}<span>Lay a flower</span></a>
        ${rank >= 2 ? (signedIn && !preview ? html`<form method="post" action="${p.url}/candle" class="inline">${csrf(req)}
            <button class="btn btn--candle" ${litCandle ? 'disabled' : ''} data-candle>${icon('candle')}<span>${litCandle ? 'You lit a candle' : 'Light a candle'}</span><span class="count">${p.candles}</span></button></form>`
          : html`<a class="btn btn--candle" href="/login?next=${encodeURIComponent(p.url)}">${icon('candle')}<span>Light a candle</span><span class="count">${p.candles}</span></a>`) : ''}
        ${tone ? html`<button type="button" class="btn btn--ghost-light" data-tone="${toneUrl(tone.file)}" aria-pressed="false">${icon('play')}<span>Play ${tone.title}</span></button>` : ''}
      </div>
    </div>
  </section>`;

  const bio = html`<section class="mem-section" id="life">
    <h2>Life story</h2>
    ${signedIn ? html`<div class="prose">${paragraphs(p.biography)}</div>`
    : html`<div class="gate"><p>Sign in to read the life story of ${p.plain}. It is free, and it lets you leave a tribute too.</p>
        <a class="btn btn--ink" href="/login?next=${encodeURIComponent(p.url)}">Sign in</a> <a class="btn btn--ghost" href="/register?next=${encodeURIComponent(p.url)}">Create an account</a></div>`}
    ${rank >= 3 && p.survivors && signedIn ? html`<h3 class="h-sub">Survived by</h3><div class="prose">${paragraphs(p.survivors)}</div>` : ''}
  </section>`;

  const video = rank >= 3 && p.video ? html`<section class="mem-section" id="video">
    <h2>A moment with ${p.first_name}</h2>
    <video class="mem-video" src="/media/${p.video}" controls playsinline preload="metadata" poster="${p.photoUrl}"></video>
  </section>` : '';

  const gallery = rank >= 2 && p.galleryList.length ? html`<section class="mem-section" id="gallery">
    <h2>Gallery</h2>
    <div class="gallery">${p.galleryList.map((g, i) => html`<button type="button" class="gallery__item" data-lightbox="/media/${g}" aria-label="Open photo ${i + 1}"><img src="/media/${g}" alt="" loading="lazy"></button>`)}</div>
  </section>` : '';

  const timeline = rank >= 3 && p.timelineList.length ? html`<section class="mem-section" id="timeline">
    <h2>A life in moments</h2>
    <ol class="timeline">
      <li><span class="timeline__y">${p.dob.slice(0, 4)}</span><span>Born${p.state ? html` in ${p.state}` : ''}</span></li>
      ${p.timelineList.map((t) => html`<li><span class="timeline__y">${t.year}</span><span>${t.text}</span></li>`)}
      <li><span class="timeline__y">${p.dod.slice(0, 4)}</span><span>Passed on${p.age ? html`, aged ${p.age.label}` : ''}</span></li>
    </ol>
  </section>` : '';

  const events = rank >= 3 && p.eventsList.length ? html`<section class="mem-section" id="service">
    <h2>Order of service</h2>
    <ul class="events">${p.eventsList.map((e) => html`<li class="event">
      <span class="event__date">${e.date ? html`<strong>${new Date(e.date).getUTCDate()}</strong>${fmtDate(e.date).split(' ').slice(1).join(' ')}` : ''}</span>
      <span class="event__body"><strong>${e.title}</strong>${e.time ? html`<span>${fmtTime(e.time)}</span>` : ''}${e.venue ? html`<span>${e.venue}</span>` : ''}
        ${e.venue ? html`<a class="small" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.venue)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}</span>
    </li>`)}</ul>
    <p><a class="btn btn--ghost btn--sm" href="${p.url}/programme">Open the printable programme</a></p>
  </section>` : '';

  const tributeForm = html`<section class="mem-section" id="tribute-form">
    <h2>Leave a tribute</h2>
    ${preview ? html`<p class="muted">Tributes open once the memorial is published.</p>`
    : !signedIn ? html`<div class="gate"><p>Sign in to leave a tribute for ${p.plain}. A tribute costs ${naira(fee)}. Of that, ${naira(fee * 0.4)} goes to charity and ${naira(fee * 0.4)} to the family.</p>
        <a class="btn btn--ink" href="/login?next=${encodeURIComponent(p.url + '#tribute-form')}">Sign in to leave a tribute</a></div>`
    : isOwner ? html`<p class="muted">You created this memorial, so tributes here come from others. Share it with friends and family.</p>`
    : myTribute && myTribute.status !== 'pending_payment' ? html`<p class="muted">You have already left your tribute for ${p.plain}. Each person can leave one tribute per memorial. <a href="#tribute-${myTribute.id}">Read your tribute</a>.</p>`
    : html`<form class="card form tribute-form" method="post" action="${p.url}/tribute">${csrf(req)}
        <label class="field"><span>Your relationship to ${p.first_name} <em class="opt">optional</em></span>
          <input name="relationship" maxlength="60" placeholder="e.g. Former student, neighbour, colleague" value="${tDraft?.relationship || myTribute?.relationship || ''}"></label>
        <label class="field"><span>Your tribute</span>
          <textarea name="message" rows="${maxWords > 500 ? 10 : 6}" required minlength="20" placeholder="Share a memory, a lesson, or a farewell." data-word-limit="${maxWords}">${tDraft?.message || myTribute?.message || ''}</textarea>
          <small><span data-word-count>Up to ${maxWords} words.</span> You can leave one tribute on this memorial, so take your time.</small></label>
        <div class="split-note">
          <p>Tribute fee <strong>${naira(fee)}</strong></p>
          <ul><li>${naira(fee * 0.4)} to hospitals, orphanages and health research</li><li>${naira(fee * 0.4)} to the family who created this memorial</li><li>${naira(fee * 0.2)} to keep tillwemeet running</li></ul>
        </div>
        <button class="btn btn--brass">Pay ${naira(fee)} and publish tribute</button>
      </form>`}
  </section>`;

  const flowerSection = html`<section class="mem-section" id="flowers">
    <h2>Flowers <span class="count-label">${p.flower_count}</span></h2>
    ${flowers.length ? html`${flowerList(flowers)}${p.flower_count > flowers.length ? html`<p><a href="${p.url}/flowers">See all ${p.flower_count} flowers</a></p>` : ''}`
    : html`<p class="muted">No flowers yet. Lay the first one for ${p.first_name}.</p>`}
    <div id="lay-flower" class="lay-flower">
      <h3 class="h-sub">Lay a flower</h3>
      ${preview ? html`<p class="muted">Flowers can be laid once the memorial is published.</p>`
      : !signedIn ? html`<div class="gate"><p>Sign in to lay a flower for ${p.plain}. A flower costs ${naira(flowerFee)}, and you can lay one whenever you visit. You’ll get a card to share.</p>
          <a class="btn btn--ink" href="/login?next=${encodeURIComponent(p.url + '#lay-flower')}">Sign in to lay a flower</a></div>`
      : html`<form class="card form flower-form" method="post" action="${p.url}/flower">${csrf(req)}
          <fieldset class="flower-pick"><legend>Choose a flower</legend>
            ${FL.KEYS.map((k, i) => html`<label class="flower-opt">
              <input type="radio" name="flower" value="${k}" ${(draftFlower.flower ? draftFlower.flower === k : i === 0) ? 'checked' : ''} required>
              ${raw(FL.flowerSvg(k, 'flower-opt__art'))}
              <span class="flower-opt__name">${FL.FLOWERS[k].name}</span>
              <span class="flower-opt__meaning">${FL.FLOWERS[k].meaning}</span>
            </label>`)}
          </fieldset>
          <label class="field"><span>A short note <em class="opt">optional</em></span>
            <textarea name="note" rows="3" placeholder="Rest well, Papa. We miss you every day." data-word-limit="${config.flowerNoteWords}">${draftFlower.note || ''}</textarea>
            <small data-word-count>Up to ${config.flowerNoteWords} words.</small></label>
          <div class="split-note">
            <p>Flower <strong>${naira(flowerFee)}</strong></p>
            <ul><li>${naira(flowerFee * 0.4)} to hospitals, orphanages and health research</li><li>${naira(flowerFee * 0.4)} to the family who created this memorial</li><li>${naira(flowerFee * 0.2)} to keep tillwemeet running</li></ul>
          </div>
          <button class="btn btn--brass">Pay ${naira(flowerFee)} and lay flower</button>
          <p class="muted small">After paying you get a card to download and share.</p>
        </form>`}
    </div>
  </section>`;

  const tributeList = html`<section class="mem-section" id="tributes">
    <h2>Tributes <span class="count-label">${tributes.length}</span></h2>
    ${tributes.length ? html`<ol class="tributes">${tributes.map((t) => html`<li class="tribute" id="tribute-${t.id}">
      <blockquote>${paragraphs(t.message)}</blockquote>
      <footer><strong>${t.full_name}</strong>${t.relationship ? html`<span>${t.relationship}</span>` : ''}<time>${fmtDateTime(t.paid_at)}</time></footer>
      <details class="tribute__share"><summary>Share</summary>${shareLinks(`${config.baseUrl}/t/${t.id}`, `${t.full_name}'s tribute to ${p.name} on tillwemeet:`, { compact: true })}</details>
    </li>`)}</ol>`
    : html`<p class="muted">No tributes yet. Be the first to honour ${p.first_name}.</p>`}
  </section>`;

  const body = html`<article class="memorial memorial--${p.category}">
    ${preview ? html`<p class="preview-bar">Preview. ${p.status === 'approved' ? '' : 'This memorial isn’t public yet.'}</p>` : ''}
    ${hero}
    <div class="memorial__body">
      <div class="memorial__main">${video}${bio}${timeline}${gallery}${events}${flowerSection}${tributeList}${tributeForm}</div>
      <aside class="memorial__side">
        <div class="side-card">
          <h2 class="h-sub">Share this memorial</h2>
          ${shareLinks(url, shareText)}
        </div>
        <div class="side-card side-card--quiet">
          <p>Tributes and flowers have raised <strong>${naira(charityRaised)}</strong> for charity in ${p.first_name}’s name.</p>
          <a class="small" href="/charity">Where the money goes</a>
        </div>
      </aside>
    </div>
  </article>
  <div class="lightbox" hidden data-lightbox-box><button type="button" class="lightbox__close" aria-label="Close">${icon('close')}</button><img alt=""></div>`;

  return layout(req, {
    title: `${p.name} (${p.years})`,
    description: `In loving memory of ${p.name}, ${p.years}. Read their story and leave a tribute.`,
    og: { title: `In loving memory of ${p.name}`, description: `${p.years}. ${p.epitaph || 'Visit the memorial and leave a tribute.'}`, image: `${config.baseUrl}${p.photoUrl}`, url },
    bodyClass: `page-memorial theme-${p.category}`,
    body,
  });
}

function flowerList(rows) {
  return html`<ul class="flowers">${rows.map((f) => html`<li class="flower-item">
    <a href="/f/${f.id}" class="flower-item__art" aria-label="Open ${f.full_name}'s flower card">${raw(FL.flowerSvg(f.flower))}</a>
    <div class="flower-item__body">
      <p class="flower-item__who"><strong>${f.full_name}</strong> laid a ${(FL.FLOWERS[f.flower] || FL.FLOWERS.lily).name.toLowerCase()}</p>
      ${f.note ? html`<p class="flower-item__note">${f.note}</p>` : ''}
      <time>${fmtDateTime(f.paid_at)}</time>
    </div>
  </li>`)}</ul>`;
}

function programmePage(req, p) {
  const place = [p.lga, p.state, p.country].filter(Boolean).join(', ');
  return layout(req, {
    title: `Funeral programme for ${p.plain}`,
    bodyClass: 'page-programme',
    body: html`<article class="programme">
      <p class="no-print"><a href="${p.url}">Back to the memorial</a> <button type="button" class="btn btn--ink btn--sm" data-print>Print or save as PDF</button></p>
      <header class="programme__cover">
        <p class="programme__intro">Celebrating the life of</p>
        <img src="${p.photoUrl}" alt="">
        ${p.titles ? html`<p class="programme__titles">${p.titles.split(',').join(' ')}</p>` : ''}
        <h1>${p.first_name} ${p.middle_name || ''} ${p.last_name}</h1>
        <p class="programme__years">${fmtDate(p.dob)} to ${fmtDate(p.dod)}</p>
        ${p.epitaph ? html`<p class="programme__epitaph">${p.epitaph}</p>` : ''}
        <p>${place}</p>
      </header>
      ${p.eventsList.length ? html`<section><h2>Order of service</h2><ul class="events">${p.eventsList.map((e) => html`<li class="event"><span class="event__body"><strong>${e.title}</strong><span>${[e.date ? fmtDate(e.date) : '', fmtTime(e.time), e.venue].filter(Boolean).join(', ')}</span></span></li>`)}</ul></section>` : ''}
      <section><h2>Life story</h2><div class="prose">${paragraphs(p.biography)}</div></section>
      ${p.timelineList.length ? html`<section><h2>A life in moments</h2><ol class="timeline">${p.timelineList.map((t) => html`<li><span class="timeline__y">${t.year}</span><span>${t.text}</span></li>`)}</ol></section>` : ''}
      ${p.survivors ? html`<section><h2>Survived by</h2><div class="prose">${paragraphs(p.survivors)}</div></section>` : ''}
      <footer class="programme__foot">Visit the memorial and leave a tribute: ${config.baseUrl}${p.url}</footer>
    </article>`,
  });
}

module.exports = { memorialPage, programmePage, paragraphs, flowerList };
