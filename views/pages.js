const config = require('../lib/config');
const db = require('../lib/db'); // prices() reads an in-memory cache
const { html, naira, fmtDate } = require('../lib/util');
const { layout } = require('./layout');
const { FEATURES } = require('./memorial-form');

function about(req) {
  return layout(req, {
    title: 'About',
    body: html`<section class="page prose-page">
      <h1>About tillwemeet</h1>
      <div class="prose">
        <p>When someone dies, the news travels fast and then disappears. Obituary posters fade on walls. Messages scroll away in group chats. tillwemeet gives every life a permanent place that anyone, anywhere, can visit.</p>
        <p>Each memorial is a headstone on our digital grounds. Behind it sits the person’s life story, photos, and the tributes left by the people who knew them. A daughter in Lagos, a classmate in Houston and a neighbour in Owerri can all stand at the same graveside.</p>
        <h2>Verified, not just posted</h2>
        <p>Before a memorial is published, our team checks the death certificate and the identity of the person who created it. We call another family member when anything is unclear. False death announcements cause real pain, and we work hard to keep them off tillwemeet.</p>
        <h2>Tributes that give back</h2>
        <p>Every tribute and every flower is a small gift. 40% goes to hospitals, orphanages and health research programmes. 40% goes to the family who created the memorial, to help with the cost of saying goodbye. The remaining 20% keeps the platform running.</p>
        <h2>The name</h2>
        <p>“Till we meet again” is written on headstones, sung at funerals and said at gravesides across the world. It is how we say goodbye without saying it is the end.</p>
      </div>
      <p><a class="btn btn--brass" href="/create">Create a memorial</a> <a class="btn btn--ghost" href="/how-it-works">How it works</a></p>
    </section>`,
  });
}

function howItWorks(req) {
  const cats = config.selectableCategories;
  const legendFee = db.prices('legend').tributeFee;
  return layout(req, {
    title: 'How it works',
    body: html`<section class="page prose-page">
      <h1>How tillwemeet works</h1>
      <nav class="toc" aria-label="On this page">
        <a href="#creating">Creating a memorial</a><a href="#categories">Categories and pricing</a><a href="#verification">Verification</a>
        <a href="#tributes">Tributes</a><a href="#flowers">Flowers</a><a href="#earnings">Earnings and charity</a><a href="#editing">Editing</a><a href="#legends">Legends</a><a href="#faq">Questions</a>
      </nav>

      <h2 id="creating">Creating a memorial</h2>
      <div class="prose">
        <ol>
          <li>Create a free account and choose <a href="/create">Create a memorial</a>.</li>
          <li>Choose a category: Regular, VIP or VVIP.</li>
          <li>Enter the person’s titles, names, dates of birth and death, and where they came from: country, state or region, and local government area or county. We calculate their age for you.</li>
          <li>Write their life story and add a portrait.</li>
          <li>Attach the death certificate and tell us about yourself: your relationship to them, your NIN, a photo of you, and the phone number of another family member.</li>
          <li>Pay the listing fee. The memorial goes to our team for review.</li>
          <li>Once approved, the headstone appears on the homepage under its category.</li>
        </ol>
      </div>

      <h2 id="categories">Categories and pricing</h2>
      <div class="price-table">
        ${cats.map((k) => { const c = config.categories[k]; const pr = db.prices(k); return html`<div class="price-col price-col--${k}">
          <h3>${c.name}</h3>
          <p class="price-col__fee">${naira(pr.listingFee)}<span>one-time listing fee</span></p>
          <p class="price-col__trib">Tributes: ${naira(pr.tributeFee)}, up to ${c.tributeWords.toLocaleString()} words<br>Flowers: ${naira(pr.flowerFee)} each</p>
          <ul>${FEATURES[k].map((f) => html`<li>${f}</li>`)}</ul>
          <a class="btn btn--ghost btn--sm" href="/create?category=${k}">Create a ${c.name} memorial</a>
        </div>`; })}
      </div>
      <p class="muted">You can upgrade a memorial later and pay only the difference.</p>

      <h2 id="verification">Verification</h2>
      <div class="prose">
        <p>We review every memorial before it goes live, usually within 24 hours of payment. We check that the certificate matches the details you entered, that your photo matches your identity, and we may call the family member you named. Your documents and NIN are only seen by our verification team. NINs are stored encrypted.</p>
        <p>If something needs to change, we tell you exactly what. Edit the memorial and it comes straight back to us. If a memorial can’t be verified, we refund the listing fee.</p>
      </div>

      <h2 id="tributes">Tributes</h2>
      <div class="prose">
        <p>Anyone with a tillwemeet account can leave a tribute: a memory, a prayer or a farewell. Each person can leave one tribute per memorial, so it carries weight. Tributes can be up to ${config.categories.regular.tributeWords} words on Regular memorials, ${config.categories.vip.tributeWords} on VIP and ${config.categories.vvip.tributeWords.toLocaleString()} on VVIP and Legend memorials. The fee depends on the memorial’s category: ${cats.map((k) => `${naira(db.prices(k).tributeFee)} for ${config.categories[k].name}`).join(', ')}, and ${naira(legendFee)} for Legends.</p>
        <p>Every tribute can be shared to WhatsApp, Facebook, X and LinkedIn, or copied as a link. You need to be signed in to read a full life story or to leave a tribute.</p>
      </div>

      <h2 id="flowers">Flowers</h2>
      <div class="prose">
        <p>Visitors can lay a flower on any memorial, as often as they like: a white lily, red rose, marigold, chrysanthemum or pink carnation, with an optional note of up to ${config.flowerNoteWords} words. Everyone who visits the memorial can see who laid flowers.</p>
        <p>A flower costs ${cats.map((k) => `${naira(db.prices(k).flowerFee)} on ${config.categories[k].name}`).join(', ')} memorials, and ${naira(db.prices('legend').flowerFee)} on Legends. After paying, you get a card with the person’s photo, your flower and your note, ready to download and post to WhatsApp, Instagram or Facebook.</p>
      </div>

      <h2 id="earnings">Earnings and charity</h2>
      <div class="split-graphic" role="img" aria-label="Each tribute and flower is split 40% charity, 40% family, 20% platform">
        <span class="split-graphic__part split-graphic__part--charity" style="flex:${config.split.charity}"><strong>${config.split.charity}%</strong> charity</span>
        <span class="split-graphic__part split-graphic__part--family" style="flex:${config.split.creator}"><strong>${config.split.creator}%</strong> family</span>
        <span class="split-graphic__part split-graphic__part--platform" style="flex:${config.split.platform}"><strong>${config.split.platform}%</strong> tillwemeet</span>
      </div>
      <div class="prose">
        <p>The person who created a memorial earns 40% of every tribute and flower paid for on it. Earnings build up in your account. Add your bank details and withdraw any time once you have at least ₦1,000. Withdrawals reach your bank within 3 working days.</p>
        <p>The charity share is given to the <a href="/charity">hospitals, orphanages and health research programmes</a> we partner with. We publish every disbursement.</p>
      </div>

      <h2 id="editing">Editing a memorial</h2>
      <div class="prose">
        <p>Until a memorial is published you can change it as often as you like. Once it is live:</p>
        <ul>
          <li>Your first edit can be made at any time.</li>
          <li>After that, each new edit opens 90 days after the previous one.</li>
          <li>Changes are checked by our team before they appear. The memorial stays live while we look.</li>
          <li>If we can’t accept a change, your edit allowance is returned.</li>
          <li>Upgrading the category opens an extra edit, so you can add the tone, gallery or video straight away.</li>
        </ul>
      </div>

      <h2 id="legends">Legends</h2>
      <div class="prose"><p>Legends can’t be bought. The tillwemeet team names a memorial a Legend when the person’s life had a lasting effect on their community, their profession or the nation. Legend memorials get every VVIP feature and a bronze headstone at the top of the homepage.</p></div>

      <h2 id="faq">Questions</h2>
      <div class="faq">
        <details><summary>Who can create a memorial?</summary><p>A family member, or someone acting with the family’s permission, who can provide the death certificate.</p></details>
        <details><summary>Can I create a memorial for someone who died years ago?</summary><p>Yes, as long as you can provide proof of death.</p></details>
        <details><summary>Can I remove a tribute?</summary><p>You can report any tribute on a memorial you created. Our moderators hide tributes that are abusive, false or spam.</p></details>
        <details><summary>How do I pay?</summary><p>By card, bank transfer or USSD through Paystack. Prices are in Naira.</p></details>
        <details><summary>Why do I need to sign in to read a life story?</summary><p>It protects families from scraping and spam, and it lets us show who has visited and left tributes.</p></details>
      </div>
    </section>`,
  });
}

function charity(req, { partners, raised, given, recent }) {
  const KIND = { hospital: 'Hospital', orphanage: 'Orphanage', research: 'Health research' };
  return layout(req, {
    title: 'Charity partners',
    body: html`<section class="page prose-page">
      <h1>Where the charity share goes</h1>
      <p class="lede">40% of every tribute is set aside for hospitals, orphanages and health research programmes.</p>
      <div class="stats">
        <div class="stat"><span class="stat__n">${naira(raised)}</span><span class="stat__l">Raised through tributes</span></div>
        <div class="stat"><span class="stat__n">${naira(given)}</span><span class="stat__l">Given to partners so far</span></div>
      </div>
      <h2>Our partners</h2>
      ${partners.length ? html`<ul class="partners">${partners.map((c) => html`<li><strong>${c.name}</strong><span class="muted">${KIND[c.kind] || c.kind}${c.location ? `, ${c.location}` : ''}</span>${c.description ? html`<p>${c.description}</p>` : ''}</li>`)}</ul>` : html`<p class="muted">Partners will be listed here soon.</p>`}
      <h2>Recent disbursements</h2>
      ${recent.length ? html`<table class="table"><thead><tr><th>Date</th><th>Partner</th><th>Amount</th></tr></thead><tbody>${recent.map((d) => html`<tr><td>${fmtDate(d.created_at.slice(0, 10))}</td><td>${d.charity_name}</td><td>${naira(d.amount)}</td></tr>`)}</tbody></table>` : html`<p class="muted">The first disbursement will be published here.</p>`}
    </section>`,
  });
}

function terms(req) {
  return layout(req, {
    title: 'Terms and privacy',
    body: html`<section class="page prose-page"><h1>Terms and privacy</h1><div class="prose">
      <p><em>Replace this summary with terms reviewed by your lawyer before launch.</em></p>
      <h2>Publishing memorials</h2>
      <p>You may only create a memorial for a person who has died, with the permission of their family, and you must provide genuine documents. tillwemeet may refuse, suspend or remove any memorial. Knowingly publishing a false death announcement may be reported to the authorities.</p>
      <h2>Payments and refunds</h2>
      <p>Listing fees are refunded if a memorial can’t be verified. Tribute and flower fees are not refundable once published. The split is 40% to charity partners, 40% to the memorial creator and 20% to tillwemeet.</p>
      <h2>Tributes</h2>
      <p>Tributes must be respectful. We hide tributes that are abusive, false, commercial or spam. Hidden tributes are not refunded.</p>
      <h2>Your data</h2>
      <p>We collect what is needed to verify memorials: identity details, NIN, photos and documents. Verification documents and NINs are never shown publicly and are only accessed by our verification team. NINs are encrypted at rest. We process personal data in line with the Nigeria Data Protection Act 2023. Contact privacy@tillwemeet.com to access or delete your data.</p>
    </div></section>`,
  });
}

function errorPage(req, status, msg) {
  return layout(req, {
    title: status === 404 ? 'Not found' : 'Something went wrong',
    body: html`<section class="narrow error-page">
      <p class="error-page__code">${status}</p>
      <h1>${status === 404 ? 'We couldn’t find that page' : status === 403 ? 'You can’t open this page' : status === 429 ? 'Slow down a little' : status >= 500 ? 'Something went wrong' : 'That didn’t work'}</h1>
      <p>${msg}</p>
      <p><button type="button" class="btn btn--ink" data-back>Go back</button><a class="btn btn--ghost" href="/">Go to the homepage</a></p>
    </section>`,
  });
}

module.exports = { about, howItWorks, charity, terms, errorPage };
