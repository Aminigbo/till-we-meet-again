const config = require('../lib/config');
const { html, raw, esc } = require('../lib/util');

const icon = (name, cls = '') => raw(`<svg class="i ${cls}" aria-hidden="true"><use href="/static/img/icons.svg#${name}"/></svg>`);

function csrf(req) { return html`<input type="hidden" name="_csrf" value="${req.session.csrf}">`; }

function flash(req) {
  const items = req.session.flash || [];
  delete req.session.flash;
  if (!items.length) return '';
  return html`<div class="flash-stack" role="status">${items.map((f) => html`<p class="flash flash--${f.type}">${f.msg}</p>`)}</div>`;
}

function stoneCard(p, opts = {}) {
  const titles = (p.titles || '').split(',').map((t) => t.trim()).filter(Boolean).join(' ');
  const name = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
  return html`<a class="stone stone--${p.category}${opts.large ? ' stone--large' : ''}" href="${p.url}">
    <span class="stone__face">
      ${p.category === 'legend' ? html`<span class="stone__laurel">${icon('laurel')}</span>` : ''}
      <span class="stone__photo"><img src="${p.photoUrl}" alt="" loading="lazy"></span>
      ${titles ? html`<span class="stone__titles">${titles}</span>` : ''}
      <span class="stone__name">${name}</span>
      <span class="stone__years">${p.years}</span>
      <span class="stone__counts"><span title="Tributes">${icon('quill')}<span class="sr">Tributes: </span>${p.tribute_count ?? 0}</span><span title="Flowers">${icon('flower')}<span class="sr">Flowers: </span>${p.flower_count ?? 0}</span></span>
      <span class="stone__more">View more</span>
    </span>
    <span class="stone__plinth" aria-hidden="true"></span>
  </a>`;
}

function shareLinks(url, text, opts = {}) {
  const u = encodeURIComponent(url); const t = encodeURIComponent(text);
  return html`<div class="share${opts.compact ? ' share--compact' : ''}" data-share-url="${url}" data-share-text="${text}">
    <a class="share__btn share__btn--wa" href="https://wa.me/?text=${t}%20${u}" target="_blank" rel="noopener">${icon('whatsapp')}<span>WhatsApp</span></a>
    <a class="share__btn" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener">${icon('facebook')}<span>Facebook</span></a>
    <a class="share__btn" href="https://twitter.com/intent/tweet?text=${t}&url=${u}" target="_blank" rel="noopener">${icon('x')}<span>X</span></a>
    <a class="share__btn" href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener">${icon('linkedin')}<span>LinkedIn</span></a>
    <button type="button" class="share__btn" data-copy="${url}">${icon('link')}<span>Copy link</span></button>
  </div>`;
}

function pager(base, page, total, per) {
  const pages = Math.ceil(total / per);
  if (pages <= 1) return '';
  const sep = base.includes('?') ? '&' : '?';
  const links = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 2) links.push(i === page ? html`<span aria-current="page">${i}</span>` : html`<a href="${base}${sep}page=${i}">${i}</a>`);
    else if (links[links.length - 1] !== '…') links.push('…');
  }
  return html`<nav class="pager" aria-label="Pages">${links}</nav>`;
}

function layout(req, { title, body, description, og, bodyClass = '', head = '' }) {
  const u = req.user;
  const pageTitle = title ? `${title} — tillwemeet` : 'tillwemeet — a resting place everyone can visit';
  const desc = description || 'tillwemeet is a digital cemetery where families publish verified memorials and friends leave tributes that support charity.';
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${desc}">
<meta property="og:site_name" content="tillwemeet">
<meta property="og:title" content="${og?.title || pageTitle}">
<meta property="og:description" content="${og?.description || desc}">
<meta property="og:type" content="website">
${og?.image ? html`<meta property="og:image" content="${og.image}">` : ''}
${og?.url ? html`<meta property="og:url" content="${og.url}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#1F2436">
<link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..600&family=Instrument+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/static/css/app.css?v=1">
${head}
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
  <div class="site-head__in">
    <a class="wordmark" href="/" aria-label="tillwemeet home">${icon('candle', 'wordmark__flame')}<span>tillwemeet</span></a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">${icon('menu')}<span class="sr">Menu</span></button>
    <nav id="site-nav" class="site-nav" aria-label="Main">
      <a href="/memorials">Memorials</a>
      <a href="/how-it-works">How it works</a>
      <a href="/about">About</a>
      ${u ? html`
        <a href="/account">My account</a>
        ${u.role === 'admin' ? html`<a href="/admin">Admin</a>` : ''}
        <form method="post" action="/logout" class="inline">${csrf(req)}<button class="linklike">Sign out</button></form>
      ` : html`<a href="/login">Sign in</a>`}
      <a class="btn btn--brass btn--sm" href="/create">Create a memorial</a>
    </nav>
  </div>
</header>
${flash(req)}
<main id="main">${body}</main>
<footer class="site-foot">
  <div class="site-foot__in">
    <div>
      <p class="wordmark wordmark--foot">${icon('candle', 'wordmark__flame')}<span>tillwemeet</span></p>
      <p class="muted">Every memorial is checked against a death certificate before it is published. 40% of every tribute goes to hospitals, orphanages and health research.</p>
    </div>
    <nav aria-label="Footer">
      <a href="/about">About tillwemeet</a>
      <a href="/how-it-works">How it works</a>
      <a href="/how-it-works#categories">Categories and pricing</a>
      <a href="/how-it-works#earnings">Earnings and charity</a>
      <a href="/charity">Charity partners</a>
      <a href="/terms">Terms and privacy</a>
    </nav>
  </div>
  <p class="site-foot__legal">© ${new Date().getFullYear()} tillwemeet. Till we meet again.</p>
</footer>
${!config.paymentsLive ? html`<p class="demo-banner">Demo mode: payments are simulated. Add a Paystack key to take real payments.</p>` : ''}
<script src="/static/js/app.js?v=1" defer></script>
</body>
</html>`;
}

module.exports = { layout, stoneCard, shareLinks, pager, icon, csrf, flash, esc };
