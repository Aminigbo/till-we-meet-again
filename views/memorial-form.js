const config = require('../lib/config');
const db = require('../lib/db'); // prices() reads an in-memory cache
const geo = require('../lib/geo');
const { toneUrl, html, naira } = require('../lib/util');
const { layout, csrf, icon } = require('./layout');

const FEATURES = {
  regular: ['Headstone on the memorials wall', 'Life story and photo', 'Tributes of up to 250 words', 'Flowers from visitors, each with a shareable card', '40% of every tribute and flower shared back to you'],
  vip: ['Everything in Regular', 'Tributes of up to 500 words', 'A solemn tone plays on the memorial', 'Photo gallery of up to 6 pictures', 'White marble and brass finish', 'Visitors can light a candle', 'Epitaph line under the name', 'Listed above Regular memorials'],
  vvip: ['Everything in VIP', 'Tributes of up to 1,500 words', 'A 15–30 second video on the memorial', 'Gallery of up to 12 pictures', 'Life timeline and order of service', 'Black granite and gold-leaf finish', 'Verified family seal', 'Homepage spotlight and printable programme'],
};

function err(errors, k) { return errors && errors[k] ? html`<small class="field-error" role="alert">${errors[k]}</small>` : ''; }

function categoryPicker(selected) {
  return html`<fieldset class="tier-pick">
    <legend class="sr">Choose a category</legend>
    ${config.selectableCategories.map((k) => {
      const c = config.categories[k]; const pr = db.prices(k);
      return html`<label class="tier tier--${k}">
        <input type="radio" name="category" value="${k}" ${selected === k ? 'checked' : ''} required>
        <span class="tier__head"><span class="tier__name">${c.name}</span><span class="tier__price">${naira(pr.listingFee)}</span></span>
        <span class="tier__note">Tributes ${naira(pr.tributeFee)} (up to ${c.tributeWords} words), flowers ${naira(pr.flowerFee)}</span>
        <ul>${FEATURES[k].map((f) => html`<li>${f}</li>`)}</ul>
      </label>`;
    })}
  </fieldset>`;
}

function toneOptions(selected, tones = []) {
  return html`<div class="tones">
    <label class="tone"><input type="radio" name="tone_id" value="" ${!selected ? 'checked' : ''}><span class="tone__body"><span class="tone__title">No tone</span><span class="tone__desc">The memorial stays silent.</span></span></label>
    ${tones.map((t) => html`<label class="tone">
      <input type="radio" name="tone_id" value="${t.id}" ${String(selected) === String(t.id) ? 'checked' : ''}>
      <span class="tone__body"><span class="tone__title">${t.title}</span><span class="tone__desc">${t.description || ''}</span></span>
      <button type="button" class="tone__play" data-preview="${toneUrl(t.file)}" aria-label="Preview ${t.title}">${icon('play')}</button>
    </label>`)}
  </div>`;
}

function rowsOf(list, n, make) { const out = []; for (let i = 0; i < n; i++) out.push(make(list[i] || {}, i)); return out; }

/**
 * mode: 'create' | 'edit'. For edit, `p` is the existing (decorated) profile.
 */
function memorialForm(req, { mode, p = {}, values = {}, errors = {}, action, tones = [] }) {
  const v = { ...p, ...values };
  const isEdit = mode === 'edit';
  const cat = v.category || 'regular';
  const field = (name, label, attrs = {}, help) => html`<label class="field${attrs.wide ? ' field--wide' : ''}"><span>${label}${attrs.required ? '' : html` <em class="opt">optional</em>`}</span>
    <input name="${name}" value="${v[name] ?? ''}" ${attrs.type ? html`type="${attrs.type}"` : ''} ${attrs.required ? 'required' : ''} ${attrs.max ? html`maxlength="${attrs.max}"` : ''} ${attrs.list ? html`list="${attrs.list}"` : ''} ${attrs.pattern ? html`pattern="${attrs.pattern}"` : ''} ${attrs.inputmode ? html`inputmode="${attrs.inputmode}"` : ''} ${attrs.placeholder ? html`placeholder="${attrs.placeholder}"` : ''} ${attrs.dateMax ? html`max="${attrs.dateMax}"` : ''}>
    ${help ? html`<small>${help}</small>` : ''}${err(errors, name)}</label>`;
  const today = new Date().toISOString().slice(0, 10);
  const timeline = v.timelineList || (Array.isArray(v.timeline) ? v.timeline : []);
  const events = v.eventsList || (Array.isArray(v.service_events) ? v.service_events : []);
  const hasErrors = Object.keys(errors).length > 0;

  const body = html`<section class="form-page">
    <header class="form-page__head">
      <h1>${isEdit ? html`Edit the memorial for ${p.plain}` : 'Create a memorial'}</h1>
      <p>${isEdit
        ? (p.status === 'approved'
          ? 'Your changes go to our team for a quick check before they appear. The memorial stays live while we review them.'
          : 'Update the details and send the memorial for review again.')
        : 'Tell us about the person you have lost and show us the documents that confirm their passing. Our team checks every memorial before it goes live, usually within 24 hours of payment.'}</p>
      ${hasErrors ? html`<p class="form-error" role="alert">Some details need attention. Fix the fields marked below${!isEdit ? ', then attach the files again' : ''}.</p>` : ''}
    </header>

    <form class="memorial-form" method="post" action="${action}" enctype="multipart/form-data" data-memorial-form data-video-min="${config.videoMinSec}" data-video-max="${config.videoMaxSec}">
      ${csrf(req)}
      <ol class="steps-nav" aria-label="Form sections">
        ${!isEdit ? html`<li><a href="#s-category">Category</a></li>` : ''}
        <li><a href="#s-person">The person</a></li>
        <li><a href="#s-story">Life story</a></li>
        ${!isEdit ? html`<li><a href="#s-proof">Proof of death</a></li><li><a href="#s-you">About you</a></li>` : ''}
        <li data-tier-min="vip"><a href="#s-premium">Tone and gallery</a></li>
        <li data-tier-min="vvip"><a href="#s-vvip">Video and programme</a></li>
      </ol>

      <div class="form-sections">
      ${!isEdit ? html`<section id="s-category" class="form-section">
        <h2>Choose a category</h2>
        <p class="muted">The listing fee is paid once. Only the tillwemeet team can name a memorial a Legend.</p>
        ${categoryPicker(cat)}${err(errors, 'category')}
      </section>` : html`<input type="hidden" name="category" value="${cat}" data-fixed-category>`}

      <section id="s-person" class="form-section">
        <h2>The person</h2>
        <div class="grid-2">
          ${field('titles', 'Titles', { list: 'titles-list', max: 80, placeholder: 'e.g. Chief, Dr' }, 'Separate titles with commas.')}
          ${field('nickname', 'Also known as', { max: 60 })}
          ${field('first_name', 'First name', { required: true, max: 60 })}
          ${field('middle_name', 'Middle name', { max: 60 })}
          ${field('last_name', 'Surname', { required: true, max: 60 })}
          <label class="field"><span>Gender <em class="opt">optional</em></span>
            <select name="gender"><option value="">Prefer not to say</option>
              ${['Female', 'Male'].map((g) => html`<option ${v.gender === g ? 'selected' : ''}>${g}</option>`)}</select></label>
          ${field('dob', 'Date of birth', { type: 'date', required: true, dateMax: today })}
          ${field('dod', 'Date of death', { type: 'date', required: true, dateMax: today })}
          <p class="age-preview field--wide" data-age-preview aria-live="polite"></p>
          <label class="field"><span>Country</span>
            <select name="country" required data-country>${geo.countries.map((c) => html`<option ${(v.country || 'Nigeria') === c ? 'selected' : ''}>${c}</option>`)}</select>${err(errors, 'country')}</label>
          ${field('state', 'State or region', { required: true, max: 60, list: 'ng-states' })}
          ${field('lga', 'Local government area or county', { required: true, max: 80 })}
          ${field('place_of_death', 'Place of death', { max: 120, placeholder: 'Hospital, town or city' })}
          ${field('burial_date', 'Burial date', { type: 'date' })}
          ${field('burial_place', 'Place of burial or interment', { max: 160 })}
        </div>
        <label class="field field--file"><span>Portrait photo${isEdit ? html` <em class="opt">leave empty to keep the current photo</em>` : ''}</span>
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" ${isEdit ? '' : 'required'} data-preview-img>
          <small>A clear, front-facing photo. JPG, PNG or WebP, up to 5MB.</small>${err(errors, 'photo')}
          ${isEdit && p.photo ? html`<img class="thumb" src="${p.photoUrl}" alt="Current photo">` : ''}</label>
      </section>

      <section id="s-story" class="form-section">
        <h2>Life story</h2>
        <label class="field"><span>Biography</span>
          <textarea name="biography" rows="12" required minlength="80" maxlength="12000" placeholder="Where they were born, the people they loved, the work they did, what they will be remembered for.">${v.biography || ''}</textarea>
          <small>Between 80 and 12,000 characters. Signed-in visitors can read it in full.</small>${err(errors, 'biography')}</label>
        <div data-tier-min="vip">${field('epitaph', 'Epitaph', { max: 140, wide: true, placeholder: 'A short line carved under the name' }, 'One line, up to 140 characters.')}</div>
        <div data-tier-min="vvip">
          <label class="field"><span>Survived by <em class="opt">optional</em></span>
            <textarea name="survivors" rows="3" maxlength="1500" placeholder="Spouse, children, grandchildren, siblings">${v.survivors || ''}</textarea></label>
        </div>
      </section>

      ${!isEdit ? html`<section id="s-proof" class="form-section">
        <h2>Proof of death</h2>
        <p class="muted">These documents are only seen by our verification team. They never appear on the memorial.</p>
        <label class="field field--file"><span>Death certificate</span>
          <input type="file" name="death_cert" accept="application/pdf,image/jpeg,image/png,image/webp" required>
          <small>A scan or clear photo of the certificate. PDF, JPG or PNG, up to 10MB.</small>${err(errors, 'death_cert')}</label>
        <div class="grid-2">
          ${field('death_cert_number', 'Certificate number', { required: true, max: 60 })}
          ${field('death_cert_authority', 'Issued by', { required: true, max: 120, placeholder: 'e.g. National Population Commission, hospital name' })}
          ${field('cause_of_death', 'Cause of death', { max: 120 }, 'Kept private. Helps our team match the certificate.')}
        </div>
      </section>

      <section id="s-you" class="form-section">
        <h2>About you</h2>
        <p class="muted">We confirm who is publishing each memorial. Your NIN is encrypted and only the last four digits are shown to our team.</p>
        <div class="grid-2">
          <label class="field"><span>Your relationship to them</span>
            <select name="uploader_relationship" required><option value="">Choose one</option>
              ${geo.relationships.map((r) => html`<option ${v.uploader_relationship === r ? 'selected' : ''}>${r}</option>`)}</select>${err(errors, 'uploader_relationship')}</label>
          ${field('uploader_nin', 'Your NIN', { required: true, pattern: '[0-9]{11}', inputmode: 'numeric', max: 11 }, 'Your 11-digit National Identification Number.')}
          ${field('uploader_phone', 'Your phone number', { required: true, max: 20, inputmode: 'tel' })}
          ${field('uploader_address', 'Your home address', { required: true, max: 200 })}
          ${field('next_of_kin_name', 'Another family member we can call', { required: true, max: 120 })}
          ${field('next_of_kin_phone', 'Their phone number', { required: true, max: 20, inputmode: 'tel' })}
        </div>
        <label class="field field--file"><span>A recent photo of you</span>
          <input type="file" name="uploader_photo" accept="image/jpeg,image/png,image/webp" required>
          <small>A clear photo of your face. We compare it with your NIN record.</small>${err(errors, 'uploader_photo')}</label>
        <label class="field field--file"><span>A photo ID <em class="opt">optional</em></span>
          <input type="file" name="uploader_id_doc" accept="application/pdf,image/jpeg,image/png,image/webp">
          <small>NIN slip, driver's licence, voter's card or passport. Speeds up verification.</small>${err(errors, 'uploader_id_doc')}</label>
      </section>` : ''}

      <section id="s-premium" class="form-section" data-tier-min="vip">
        <h2>Tone and gallery</h2>
        <h3 class="h-sub">Memorial tone</h3>
        <p class="muted">Visitors hear this softly when they open the memorial. They can pause it at any time.</p>
        ${toneOptions(v.tone_id, tones)}
        <h3 class="h-sub">Photo gallery</h3>
        <label class="field field--file"><span>Gallery photos <em class="opt">optional</em></span>
          <input type="file" name="gallery" accept="image/jpeg,image/png,image/webp" multiple data-gallery-input>
          <small data-gallery-help>VIP memorials hold up to ${config.categories.vip.gallery} photos and VVIP up to ${config.categories.vvip.gallery}. Up to 5MB each.${isEdit ? ' New photos are added to the current gallery.' : ''}</small>${err(errors, 'gallery')}</label>
        ${isEdit && p.galleryList && p.galleryList.length ? html`<div class="thumbs">${p.galleryList.map((g) => html`<label class="thumbs__item"><img src="/media/${g}" alt=""><span><input type="checkbox" name="remove_gallery" value="${g}"> Remove</span></label>`)}</div>` : ''}
      </section>

      <section id="s-vvip" class="form-section" data-tier-min="vvip">
        <h2>Video and programme</h2>
        <label class="field field--file"><span>Tribute video${isEdit && p.video ? html` <em class="opt">leave empty to keep the current video</em>` : html` <em class="opt">optional</em>`}</span>
          <input type="file" name="video" accept="video/mp4,video/quicktime,video/webm" data-video-input>
          <small>Between ${config.videoMinSec} and ${config.videoMaxSec} seconds long. MP4, MOV or WebM, up to 50MB.</small>
          <small class="field-error" data-video-error hidden></small>${err(errors, 'video')}</label>
        <h3 class="h-sub">Life timeline</h3>
        <p class="muted">Milestones shown in order on the memorial.</p>
        <div class="repeat">${rowsOf(timeline, 8, (t, i) => html`<div class="repeat__row repeat__row--tl">
          <input name="tl_year" value="${t.year || ''}" placeholder="Year" inputmode="numeric" maxlength="4" aria-label="Milestone ${i + 1} year">
          <input name="tl_text" value="${t.text || ''}" placeholder="What happened" maxlength="160" aria-label="Milestone ${i + 1}">
        </div>`)}</div>
        <h3 class="h-sub">Order of service</h3>
        <p class="muted">Wake keeping, funeral service, interment, reception. Shown on the memorial and the printable programme.</p>
        <div class="repeat">${rowsOf(events, 4, (e, i) => html`<div class="repeat__row repeat__row--ev">
          <input name="ev_title" value="${e.title || ''}" placeholder="e.g. Funeral service" maxlength="80" aria-label="Event ${i + 1} name">
          <input name="ev_date" type="date" value="${e.date || ''}" aria-label="Event ${i + 1} date">
          <input name="ev_time" type="time" value="${e.time || ''}" aria-label="Event ${i + 1} time">
          <input name="ev_venue" value="${e.venue || ''}" placeholder="Venue and address" maxlength="160" aria-label="Event ${i + 1} venue">
        </div>`)}</div>
      </section>

      <section class="form-section form-section--submit">
        ${!isEdit ? html`<label class="check"><input type="checkbox" name="attest" value="1" required>
          <span>I confirm that this person has died, that the documents I am sending are genuine, and that I have the family's permission to publish this memorial. I understand that false memorials are removed and may be reported to the authorities.</span></label>${err(errors, 'attest')}` : ''}
        <div class="submit-row">
          <p class="muted" data-total>${!isEdit ? 'You will pay the listing fee on the next screen.' : ''}</p>
          <button class="btn btn--brass btn--lg">${isEdit ? (p.status === 'approved' ? 'Send changes for review' : 'Save and send for review') : 'Continue to payment'}</button>
        </div>
      </section>
      </div>
    </form>
    <datalist id="titles-list">${geo.titles.map((t) => html`<option value="${t}">`)}</datalist>
    <datalist id="ng-states">${geo.nigeriaStates.map((s) => html`<option value="${s}">`)}</datalist>
  </section>`;
  return layout(req, { title: isEdit ? 'Edit memorial' : 'Create a memorial', body, bodyClass: `page-form tier-${cat}` });
}

module.exports = { memorialForm, FEATURES };
