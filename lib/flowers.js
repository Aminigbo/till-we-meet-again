// Flowers visitors can lay, and the SVG drawings and shareable card for them.
const path = require('node:path');
const config = require('./config');
const storage = require('./storage');
const { esc, fmtDate } = require('./util');

const FLOWERS = {
  lily: { name: 'White lily', meaning: 'For peace and a soul at rest' },
  rose: { name: 'Red rose', meaning: 'For love that does not end' },
  marigold: { name: 'Marigold', meaning: 'For remembrance and a life that shone' },
  chrysanthemum: { name: 'Chrysanthemum', meaning: 'For honour and deep respect' },
  carnation: { name: 'Pink carnation', meaning: 'For gratitude and a mother’s love' },
};
const KEYS = Object.keys(FLOWERS);

const f = (n) => Math.round(n * 10) / 10;
function petal(len, wid, rot, fill, stroke, cx, cy, pointed = true) {
  const d = pointed
    ? `M0 0 C${f(wid)} ${f(-len * 0.25)} ${f(wid * 0.9)} ${f(-len * 0.75)} 0 ${f(-len)} C${f(-wid * 0.9)} ${f(-len * 0.75)} ${f(-wid)} ${f(-len * 0.25)} 0 0Z`
    : `M0 0 C${f(wid * 1.1)} ${f(-len * 0.15)} ${f(wid * 1.2)} ${f(-len)} 0 ${f(-len)} C${f(-wid * 1.2)} ${f(-len)} ${f(-wid * 1.1)} ${f(-len * 0.15)} 0 0Z`;
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="1" transform="translate(${cx} ${cy}) rotate(${f(rot)})"/>`;
}
function ring(n, len, wid, fill, stroke, cx, cy, offset = 0, pointed = true) {
  let s = '';
  for (let i = 0; i < n; i++) s += petal(len, wid, offset + (360 / n) * i, fill, stroke, cx, cy, pointed);
  return s;
}

const stem = (cx, top, bottom) => `<path d="M${cx} ${bottom} C${cx - 6} ${f((top + bottom) / 2)} ${cx + 6} ${f(top + 30)} ${cx} ${top}" stroke="#4E6B3F" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M${cx} ${f(bottom - 55)} C${cx - 40} ${f(bottom - 75)} ${cx - 58} ${f(bottom - 50)} ${cx - 62} ${f(bottom - 40)} C${cx - 40} ${f(bottom - 38)} ${cx - 16} ${f(bottom - 42)} ${cx} ${f(bottom - 55)}Z" fill="#5C7D49"/>
  <path d="M${cx} ${f(bottom - 95)} C${cx + 38} ${f(bottom - 118)} ${cx + 56} ${f(bottom - 95)} ${cx + 60} ${f(bottom - 85)} C${cx + 38} ${f(bottom - 82)} ${cx + 15} ${f(bottom - 86)} ${cx} ${f(bottom - 95)}Z" fill="#6A8C55"/>`;

/** A flower drawing in a 200 x 280 box. */
function flowerArt(key) {
  const cx = 100; const cy = 92;
  let head = '';
  switch (key) {
    case 'lily':
      head = ring(6, 78, 20, '#FBF8EF', '#D9D1BC', cx, cy, 0) + ring(6, 60, 9, '#F3ECD8', 'none', cx, cy, 0)
        + Array.from({ length: 6 }, (_, i) => { const a = (i * 60 + 30) * Math.PI / 180; return `<line x1="${cx}" y1="${cy}" x2="${f(cx + Math.sin(a) * 34)}" y2="${f(cy - Math.cos(a) * 34)}" stroke="#9BA65C" stroke-width="2"/><ellipse cx="${f(cx + Math.sin(a) * 36)}" cy="${f(cy - Math.cos(a) * 36)}" rx="4" ry="7" fill="#B5652E" transform="rotate(${i * 60 + 30} ${f(cx + Math.sin(a) * 36)} ${f(cy - Math.cos(a) * 36)})"/>`; }).join('')
        + `<circle cx="${cx}" cy="${cy}" r="6" fill="#C7D08A"/>`;
      break;
    case 'rose':
      head = ring(5, 66, 32, '#8E1B24', '#6C1219', cx, cy, 18, false) + ring(5, 52, 26, '#A8232E', '#7A161E', cx, cy, 54, false)
        + ring(4, 36, 20, '#BC2E39', '#86171F', cx, cy, 10, false) + ring(3, 22, 13, '#C93C46', '#8E1A23', cx, cy, 70, false)
        + `<path d="M${cx - 8} ${cy} q8 -14 16 0 q-8 8 -16 0Z" fill="#7A121A"/>`;
      break;
    case 'marigold':
      head = ring(16, 62, 14, '#E07A12', '#B35A07', cx, cy, 0, false) + ring(14, 48, 13, '#F0951C', '#C46A0B', cx, cy, 12, false)
        + ring(12, 34, 11, '#F7B230', '#D68312', cx, cy, 6, false) + ring(9, 20, 8, '#FBCB4F', '#E09A1E', cx, cy, 20, false)
        + `<circle cx="${cx}" cy="${cy}" r="7" fill="#C66A0C"/>`;
      break;
    case 'chrysanthemum':
      head = ring(28, 70, 5.5, '#F4F1E6', '#CFC8B2', cx, cy, 0) + ring(22, 54, 5, '#FAF7EE', '#D6CFB9', cx, cy, 8)
        + ring(16, 36, 4.5, '#FFFDF6', '#DCD5C0', cx, cy, 4) + ring(10, 18, 4, '#EFE3B0', '#CDBB78', cx, cy, 10)
        + `<circle cx="${cx}" cy="${cy}" r="6" fill="#D9C25E"/>`;
      break;
    case 'carnation':
    default: {
      let frills = '';
      for (let r = 0; r < 4; r++) {
        const n = 18 - r * 3; const rad = 60 - r * 14;
        for (let i = 0; i < n; i++) {
          const a = (360 / n) * i + r * 9; const rr = (a * Math.PI) / 180;
          frills += `<circle cx="${f(cx + Math.sin(rr) * rad * 0.62)}" cy="${f(cy - Math.cos(rr) * rad * 0.62)}" r="${f(rad * 0.42)}" fill="${['#E58BA0', '#EC9DAF', '#F2B1C0', '#F7C6D1'][r]}" stroke="#C9667F" stroke-width="1" stroke-dasharray="3 2"/>`;
        }
      }
      head = frills;
    }
  }
  return `${stem(cx, cy + 20, 270)}${head}`;
}

const flowerSvg = (key, cls = '') => `<svg class="${cls}" viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${flowerArt(key)}</svg>`;

// Simple word wrap for SVG text (approximate character widths for a serif at the given size)
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) { if (line) lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

async function photoDataUri(name) {
  const buf = await storage.read('public', name);
  if (!buf) return null;
  const ext = path.extname(name).slice(1).toLowerCase();
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
}

const THEMES = {
  regular: { bg1: '#2E3340', bg2: '#1F2436', ink: '#F2EEE5', soft: '#B7B4AC', accent: '#C9A35A' },
  vip: { bg1: '#F7F5EF', bg2: '#E5E1D6', ink: '#2A2418', soft: '#6B6150', accent: '#9C7A3C' },
  vvip: { bg1: '#2A2D36', bg2: '#15161B', ink: '#F0E6CF', soft: '#A99F88', accent: '#D9B86A' },
  legend: { bg1: '#4A3524', bg2: '#22180F', ink: '#F5E6C6', soft: '#C2AD86', accent: '#E8C27A' },
};

/** The shareable card a visitor gets after laying a flower (1080 x 1350 SVG). */
async function cardSvg({ flower, profile, giver }) {
  const t = THEMES[profile.category] || THEMES.regular;
  const fl = FLOWERS[flower.flower] || FLOWERS.lily;
  const photo = profile.photo ? await photoDataUri(profile.photo) : null;
  const titles = (profile.titles || '').split(',').map((s) => s.trim()).filter(Boolean).join(' ');
  const name = [profile.first_name, profile.middle_name, profile.last_name].filter(Boolean).join(' ');
  const nameSize = name.length > 26 ? 50 : name.length > 20 ? 58 : 66;
  let note = flower.note ? wrap(flower.note, 50) : [];
  if (note.length > 3) { note = note.slice(0, 3); note[2] = note[2].replace(/[\s,.;:!?-]*\S*$/, '') + '…'; }
  const serif = "Georgia, 'Times New Roman', serif";
  const caps = "'Cinzel', 'Trajan Pro', Georgia, serif";
  let y = 1072;
  const noteSvg = note.map((l, i) => `<text x="540" y="${y + i * 42}" text-anchor="middle" font-family="${serif}" font-style="italic" font-size="32" fill="${t.ink}">${i === 0 ? '“' : ''}${esc(l)}${i === note.length - 1 ? '”' : ''}</text>`).join('');
  y += note.length * 42 + (note.length ? 10 : 0);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1350" viewBox="0 0 1080 1350">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/></linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.32" r="0.5"><stop offset="0" stop-color="${t.accent}" stop-opacity="0.22"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></radialGradient>
    <clipPath id="oval"><ellipse cx="540" cy="330" rx="150" ry="186"/></clipPath>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)"/>
  <rect width="1080" height="1350" fill="url(#glow)"/>
  <rect x="36" y="36" width="1008" height="1278" rx="10" fill="none" stroke="${t.accent}" stroke-opacity="0.55" stroke-width="2"/>
  <rect x="50" y="50" width="980" height="1250" rx="6" fill="none" stroke="${t.accent}" stroke-opacity="0.25" stroke-width="1"/>
  <text x="540" y="112" text-anchor="middle" font-family="${serif}" font-size="30" font-style="italic" fill="${t.soft}">In loving memory of</text>
  ${photo ? `<image href="${photo}" xlink:href="${photo}" x="390" y="144" width="300" height="372" preserveAspectRatio="xMidYMid slice" clip-path="url(#oval)"/>` : `<ellipse cx="540" cy="330" rx="150" ry="186" fill="${t.soft}" fill-opacity="0.3"/>`}
  <ellipse cx="540" cy="330" rx="150" ry="186" fill="none" stroke="${t.accent}" stroke-width="7"/>
  ${titles ? `<text x="540" y="584" text-anchor="middle" font-family="${caps}" font-size="24" letter-spacing="5" fill="${t.accent}">${esc(titles.toUpperCase())}</text>` : ''}
  <text x="540" y="${titles ? 650 : 630}" text-anchor="middle" font-family="${caps}" font-weight="600" font-size="${nameSize}" letter-spacing="2" fill="${t.ink}">${esc(name.toUpperCase())}</text>
  <text x="540" y="${titles ? 702 : 682}" text-anchor="middle" font-family="${caps}" font-size="30" letter-spacing="6" fill="${t.soft}">${esc(profile.dob.slice(0, 4))} – ${esc(profile.dod.slice(0, 4))}</text>
  <g transform="translate(450 712) scale(0.9)">${flowerArt(flower.flower)}</g>
  <text x="540" y="1018" text-anchor="middle" font-family="${serif}" font-size="38" fill="${t.ink}"><tspan font-weight="700">${esc(giver)}</tspan> laid a ${esc(fl.name.toLowerCase())}</text>
  ${noteSvg}
  <text x="540" y="${y + 4}" text-anchor="middle" font-family="${serif}" font-size="26" font-style="italic" fill="${t.soft}">${esc(fl.meaning)}, ${esc(fmtDate((flower.paid_at || flower.created_at).slice(0, 10)))}</text>
  <line x1="420" y1="1232" x2="660" y2="1232" stroke="${t.accent}" stroke-opacity="0.5"/>
  <text x="540" y="1268" text-anchor="middle" font-family="${caps}" font-size="28" letter-spacing="4" fill="${t.accent}">TILLWEMEET</text>
  <text x="540" y="1294" text-anchor="middle" font-family="${serif}" font-size="20" fill="${t.soft}">${esc(config.baseUrl.replace(/^https?:\/\//, ''))}/m/${esc(profile.slug)}</text>
</svg>`;
}

module.exports = { FLOWERS, KEYS, flowerSvg, flowerArt, cardSvg };
