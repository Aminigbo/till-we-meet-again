(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  // Mobile navigation
  const toggle = $('.nav-toggle');
  if (toggle) toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    document.body.classList.toggle('nav-open', !open);
  });

  // Copy link + native share
  document.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const box = copy.closest('[data-share-url]');
      if (navigator.share && matchMedia('(pointer: coarse)').matches && box) {
        try { await navigator.share({ title: document.title, text: box.dataset.shareText, url: box.dataset.shareUrl }); return; } catch {}
      }
      try { await navigator.clipboard.writeText(copy.dataset.copy); } catch {
        const t = document.createElement('textarea'); t.value = copy.dataset.copy; document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
      }
      const label = copy.querySelector('span'); const old = label.textContent;
      label.textContent = 'Link copied'; setTimeout(() => (label.textContent = old), 1800);
    }
    if (e.target.closest('[data-back]')) { e.preventDefault(); history.length > 1 ? history.back() : (location.href = '/'); }
    if (e.target.closest('[data-print]')) window.print();
  });

  // Memorial tone: plays softly on open where the browser allows it, otherwise on the first tap.
  const toneBtn = $('[data-tone]');
  if (toneBtn) {
    const audio = new Audio(toneBtn.dataset.tone);
    audio.loop = true; audio.volume = 0;
    const label = toneBtn.querySelector('span'); const title = label.textContent.replace(/^Play /, '');
    const use = toneBtn.querySelector('use');
    let fade;
    const setUi = (playing) => {
      toneBtn.setAttribute('aria-pressed', String(playing));
      label.textContent = playing ? `Pause ${title}` : `Play ${title}`;
      use.setAttribute('href', `/static/img/icons.svg#${playing ? 'pause' : 'play'}`);
    };
    const fadeTo = (target, done) => {
      clearInterval(fade);
      fade = setInterval(() => {
        const v = audio.volume + (target > audio.volume ? 0.02 : -0.04);
        if ((target > audio.volume && v >= target) || (target <= audio.volume && v <= target)) { audio.volume = Math.max(0, Math.min(1, target)); clearInterval(fade); done && done(); }
        else audio.volume = Math.max(0, Math.min(1, v));
      }, 60);
    };
    const play = () => audio.play().then(() => { setUi(true); fadeTo(0.45); }).catch(() => {});
    const pause = () => fadeTo(0, () => { audio.pause(); setUi(false); });
    toneBtn.addEventListener('click', () => {
      if (audio.paused) { store.set('twm-tone-off', ''); play(); } else { store.set('twm-tone-off', '1'); pause(); }
    });
    if (store.get('twm-tone-off') !== '1') {
      audio.play().then(() => { setUi(true); fadeTo(0.45); }).catch(() => {
        const start = (ev) => { if (ev.target.closest('[data-tone]')) return; if (audio.paused && store.get('twm-tone-off') !== '1') play(); };
        ['pointerdown', 'keydown'].forEach((t) => document.addEventListener(t, start, { once: true, capture: true }));
      });
    }
  }

  // Gallery lightbox
  const box = $('[data-lightbox-box]');
  if (box) {
    const img = $('img', box);
    document.addEventListener('click', (e) => {
      const it = e.target.closest('[data-lightbox]');
      if (it) { img.src = it.dataset.lightbox; box.hidden = false; $('.lightbox__close', box).focus(); }
      else if (e.target === box || e.target.closest('.lightbox__close')) box.hidden = true;
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.hidden = true; });
  }

  // Live word counters for tributes and flower notes
  $$('[data-word-limit]').forEach((ta) => {
    const limit = Number(ta.dataset.wordLimit);
    const out = ta.closest('label').querySelector('[data-word-count]');
    const update = () => {
      const n = (ta.value.trim().match(/\S+/g) || []).length;
      out.textContent = `${n} of ${limit} words.`;
      out.classList.toggle('field-error', n > limit);
      ta.setCustomValidity(n > limit ? `Shorten this to ${limit} words or fewer.` : '');
    };
    ta.addEventListener('input', update);
    if (ta.value) update();
  });

  // Download the flower card as a PNG
  $$('[data-download-card]').forEach((btn) => btn.addEventListener('click', async () => {
    const label = btn.querySelector('span'); const old = label.textContent;
    label.textContent = 'Preparing…'; btn.disabled = true;
    try {
      const svg = await (await fetch(btn.dataset.downloadCard)).text();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
      const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
      c.getContext('2d').drawImage(img, 0, 0, 1080, 1350);
      URL.revokeObjectURL(url);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const file = new File([blob], btn.dataset.filename, { type: 'image/png' });
      if (navigator.canShare && matchMedia('(pointer: coarse)').matches && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: document.title }); label.textContent = old; btn.disabled = false; return; } catch {}
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = btn.dataset.filename;
      document.body.append(a); a.click(); a.remove();
      label.textContent = 'Card downloaded';
    } catch {
      window.open(btn.dataset.downloadCard, '_blank');
      label.textContent = old;
    }
    btn.disabled = false;
    setTimeout(() => (label.textContent = old), 2500);
  }));

  // ---------- Memorial search ----------
  const searchForm = $('[data-search-form]');
  if (searchForm) {
    const send = () => (searchForm.requestSubmit ? searchForm.requestSubmit() : searchForm.submit());
    // On small screens the filters fold away behind a button so results come first
    const toggle = $('[data-filter-toggle]');
    if (toggle && matchMedia('(max-width: 960px)').matches) {
      const setOpen = (open) => { searchForm.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
      setOpen(false);
      toggle.addEventListener('click', () => { setOpen(searchForm.hidden); if (!searchForm.hidden) $('input', searchForm).focus(); });
    }
    // Dropdowns apply straight away; text fields wait for Enter or the Search button.
    $$('[data-autosubmit]', searchForm).forEach((el) => el.addEventListener('change', () => {
      if (el.name === 'country') { $('[data-state-filter]', searchForm).value = ''; $('[data-lga-filter]', searchForm).value = ''; }
      send();
    }));
    // Changing the year type only matters if a year is chosen
    const yt = $('[name=yearType]', searchForm);
    yt.addEventListener('change', () => { if ($('[name=year]', searchForm).value) send(); });
    // Empty fields are left out of the address so links stay short
    searchForm.addEventListener('submit', () => {
      $$('input, select', searchForm).forEach((el) => { if (!el.value || (el.name === 'yearType' && (!$('[name=year]', searchForm).value || el.value === 'died')) || (el.name === 'sort' && el.value === 'recent')) el.disabled = true; });
    });

    // Place suggestions follow the chosen country and state
    const country = $('[data-country-filter]', searchForm); const state = $('[data-state-filter]', searchForm); const lga = $('[data-lga-filter]', searchForm);
    const fill = (id, list) => { $(`#${id}`).innerHTML = list.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">`).join(''); };
    let placeTimer;
    const loadPlaces = () => {
      clearTimeout(placeTimer);
      placeTimer = setTimeout(async () => {
        try {
          const r = await fetch(`/api/places?${new URLSearchParams({ country: country.value || 'Nigeria', state: state.value })}`);
          const data = await r.json(); fill('s-states', data.states); fill('s-lgas', data.lgas);
        } catch { /* suggestions are optional */ }
      }, 250);
    };
    state.addEventListener('change', loadPlaces);
    state.addEventListener('input', () => { if (!state.value) lga.value = ''; loadPlaces(); });

    // Name suggestions (combobox)
    const box = $('[data-suggest]', searchForm);
    const input = $('input', box); const list = $('ul', box);
    let items = []; let active = -1; let timer; let lastQ = '';
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const highlight = (i) => {
      active = i;
      $$('li', list).forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
      if (i >= 0) input.setAttribute('aria-activedescendant', `sq-opt-${i}`); else input.removeAttribute('aria-activedescendant');
    };
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        lastQ = q;
        try {
          const { results } = await (await fetch(`/api/memorials/suggest?q=${encodeURIComponent(q)}`)).json();
          if (lastQ !== input.value.trim()) return;
          items = results;
          if (!items.length) { close(); return; }
          list.innerHTML = items.map((it, i) => `<li id="sq-opt-${i}" role="option" aria-selected="false" data-url="${esc(it.url)}">
            <img src="${esc(it.photo)}" alt=""><span><strong>${esc(it.name)}</strong><small>${esc(it.years)}${it.place ? `, ${esc(it.place)}` : ''}</small></span></li>`).join('')
            + `<li class="suggest__all" id="sq-opt-${items.length}" role="option" aria-selected="false" data-all>See all memorials matching “${esc(q)}”</li>`;
          list.hidden = false; input.setAttribute('aria-expanded', 'true'); highlight(-1);
        } catch { close(); }
      }, 200);
    });
    const choose = (li) => { if (!li) return; if (li.hasAttribute('data-all')) { close(); send(); } else location.href = li.dataset.url; };
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      const n = $$('li', list).length;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % n); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active <= 0 ? n - 1 : active - 1); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose($$('li', list)[active]); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => { e.preventDefault(); choose(e.target.closest('li')); });
    input.addEventListener('blur', () => setTimeout(close, 100));
  }

  // Memorial form
  const form = $('[data-memorial-form]');
  if (form) {
    const RANK = { regular: 1, vip: 2, vvip: 3, legend: 4 };
    const GALLERY = { regular: 0, vip: 6, vvip: 12, legend: 12 };
    const current = () => (($('input[name=category]:checked', form) || $('[data-fixed-category]', form)) || {}).value || 'regular';
    const applyTier = () => {
      const r = RANK[current()];
      $$('[data-tier-min]').forEach((el) => {
        const show = r >= RANK[el.dataset.tierMin];
        el.hidden = !show;
        $$('input, select, textarea', el).forEach((i) => (i.disabled = !show));
      });
      document.body.className = document.body.className.replace(/tier-\w+/, `tier-${current()}`);
    };
    form.addEventListener('change', (e) => { if (e.target.name === 'category') applyTier(); });
    applyTier();

    // Age preview
    const dob = $('input[name=dob]', form); const dod = $('input[name=dod]', form); const out = $('[data-age-preview]', form);
    const age = () => {
      if (!dob.value || !dod.value) { out.textContent = ''; return; }
      const a = new Date(dob.value); const b = new Date(dod.value);
      if (b < a) { out.textContent = 'The date of death is before the date of birth.'; return; }
      let y = b.getFullYear() - a.getFullYear();
      if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) y--;
      out.textContent = y >= 1 ? `Age at passing: ${y} ${y === 1 ? 'year' : 'years'}` : 'Age at passing: under a year';
    };
    dob.addEventListener('change', age); dod.addEventListener('change', age); age();

    // Video length check in the browser (the server checks again)
    const vid = $('[data-video-input]', form); const vErr = $('[data-video-error]', form);
    const min = Number(form.dataset.videoMin); const max = Number(form.dataset.videoMax);
    if (vid) vid.addEventListener('change', () => {
      vErr.hidden = true; vid.setCustomValidity('');
      const f = vid.files[0]; if (!f) return;
      if (f.size > 50 * 1048576) { vErr.textContent = 'This video is larger than 50MB.'; vErr.hidden = false; vid.setCustomValidity('too large'); return; }
      const v = document.createElement('video'); v.preload = 'metadata';
      v.onloadedmetadata = () => {
        URL.revokeObjectURL(v.src);
        if (v.duration < min - 0.5 || v.duration > max + 0.5) {
          vErr.textContent = `This video is ${Math.round(v.duration)} seconds. Choose one between ${min} and ${max} seconds.`; vErr.hidden = false;
          vid.setCustomValidity('duration');
        }
      };
      v.src = URL.createObjectURL(f);
    });

    // Gallery count check
    const gal = $('[data-gallery-input]', form);
    if (gal) gal.addEventListener('change', () => {
      const cap = GALLERY[current()]; const existing = $$('input[name=remove_gallery]', form).filter((c) => !c.checked).length;
      gal.setCustomValidity(gal.files.length + existing > cap ? `You can add up to ${cap - existing} more photos.` : '');
      gal.reportValidity();
    });

    // Tone previews
    let preview;
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-preview]'); if (!b) return;
      e.preventDefault();
      const same = preview && preview.src.endsWith(b.dataset.preview) && !preview.paused;
      if (preview) { preview.pause(); $$('[data-preview] use', form).forEach((u) => u.setAttribute('href', '/static/img/icons.svg#play')); }
      if (same) return;
      preview = new Audio(b.dataset.preview); preview.volume = 0.5; preview.play();
      $('use', b).setAttribute('href', '/static/img/icons.svg#pause');
      setTimeout(() => preview && preview.pause(), 15000);
    });

    form.addEventListener('submit', () => {
      const btn = $('button.btn--lg', form);
      if (form.checkValidity()) { btn.disabled = true; btn.textContent = 'Uploading, please wait…'; }
    });
  }
})();
