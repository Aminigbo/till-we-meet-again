const crypto = require('node:crypto');
const config = require('./config');

// ---------- HTML templating (auto-escaping) ----------
class Safe { constructor(s) { this.s = String(s); } toString() { return this.s; } }
const raw = (s) => new Safe(s ?? '');
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const render = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
};
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += render(vals[i]); });
  return new Safe(out);
}

// ---------- Passwords (scrypt) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---------- Field encryption (AES-256-GCM) for NIN ----------
function encKey() {
  if (config.encryptionKey && /^[0-9a-f]{64}$/i.test(config.encryptionKey)) return Buffer.from(config.encryptionKey, 'hex');
  return crypto.createHash('sha256').update('tillwemeet:' + config.sessionSecret).digest();
}
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
function decrypt(blob) {
  if (!blob) return '';
  try {
    const [iv, tag, data] = blob.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
  } catch { return '[unreadable]'; }
}
const maskNin = (n) => (n && n.length >= 4 ? '*******' + n.slice(-4) : '');

// ---------- Misc ----------
const token = (n = 24) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'memorial';
}

function naira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const dt = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  return dt.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
}
const year = (iso) => (iso ? String(iso).slice(0, 4) : '');

// Age at death, computed from date of birth and date of death.
function computeAge(dob, dod) {
  if (!dob || !dod) return null;
  const [by, bm, bd] = dob.split('-').map(Number);
  const [dy, dm, dd] = dod.split('-').map(Number);
  let years = dy - by;
  if (dm < bm || (dm === bm && dd < bd)) years--;
  if (years >= 1) return { years, label: `${years} ${years === 1 ? 'year' : 'years'}` };
  const ms = Date.UTC(dy, dm - 1, dd) - Date.UTC(by, bm - 1, bd);
  const days = Math.floor(ms / 86400000);
  if (days >= 31) {
    let months = (dy - by) * 12 + (dm - bm); if (dd < bd) months--;
    return { years: 0, label: `${months} ${months === 1 ? 'month' : 'months'}` };
  }
  return { years: 0, label: `${days} ${days === 1 ? 'day' : 'days'}` };
}

function isoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s)) ? s : null; }
const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const addDays = (iso, days) => new Date(new Date(iso.replace(' ', 'T') + 'Z').getTime() + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);

function displayName(p) {
  const titles = (p.titles || '').split(',').map((t) => t.trim()).filter(Boolean).join(' ');
  return [titles, p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
const plainName = (p) => [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');

// ---------- Cookies ----------
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ---------- Multipart/form-data parser ----------
function parseMultipart(buf, contentType) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw new Error('No multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}; const files = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (buf[pos] === 45 && buf[pos + 1] === 45) break; // closing --
    pos += 2; // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd === -1) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    if (next === -1) break;
    const body = buf.slice(headEnd + 4, next - 2);
    const name = (head.match(/name="([^"]*)"/i) || [])[1];
    const filename = (head.match(/filename="([^"]*)"/i) || [])[1];
    const ctype = (head.match(/content-type:\s*([^\r\n]+)/i) || [])[1];
    if (name !== undefined) {
      if (filename !== undefined) {
        if (body.length > 0 && filename) (files[name] = files[name] || []).push({ filename, type: ctype || 'application/octet-stream', data: body, size: body.length });
      } else {
        const v = body.toString('utf8');
        if (fields[name] === undefined) fields[name] = v;
        else fields[name] = [].concat(fields[name], v);
      }
    }
    pos = next;
  }
  return { fields, files };
}

// Detect real file type from magic bytes (never trust the browser's claim).
function sniff(data) {
  const h = data.slice(0, 16);
  const hex = h.toString('hex');
  if (hex.startsWith('ffd8ff')) return { ext: 'jpg', kind: 'image', mime: 'image/jpeg' };
  if (hex.startsWith('89504e47')) return { ext: 'png', kind: 'image', mime: 'image/png' };
  if (h.slice(0, 4).toString() === 'RIFF' && h.slice(8, 12).toString() === 'WEBP') return { ext: 'webp', kind: 'image', mime: 'image/webp' };
  if (h.slice(0, 4).toString() === '%PDF') return { ext: 'pdf', kind: 'pdf', mime: 'application/pdf' };
  if (h.slice(4, 8).toString() === 'ftyp') {
    const brand = h.slice(8, 12).toString();
    if (brand.startsWith('qt')) return { ext: 'mov', kind: 'video', mime: 'video/quicktime' };
    return { ext: 'mp4', kind: 'video', mime: 'video/mp4' };
  }
  if (hex.startsWith('1a45dfa3')) return { ext: 'webm', kind: 'video', mime: 'video/webm' };
  if (h.slice(0, 3).toString() === 'ID3' || hex.startsWith('fffb') || hex.startsWith('fff3')) return { ext: 'mp3', kind: 'audio', mime: 'audio/mpeg' };
  if (h.slice(0, 4).toString() === 'OggS') return { ext: 'ogg', kind: 'audio', mime: 'audio/ogg' };
  return null;
}

// Built-in tones live in public/tones; tones uploaded by admins live with other uploads.
const toneUrl = (file) => (String(file).startsWith('tone-') ? `/media/${file}` : `/static/tones/${file}`);

// Search tokens: lower-cased word prefixes (2+ letters), so "Oko" finds "Okonkwo".
function searchTokens(...parts) {
  const out = new Set();
  for (const p of parts) {
    for (const w of String(p || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9@.+]+/)) {
      for (let i = 2; i <= Math.min(w.length, 20); i++) out.add(w.slice(0, i));
    }
  }
  return [...out];
}
const queryWords = (q) => String(q || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9@.+]+/).filter((w) => w.length >= 2).map((w) => w.slice(0, 20));

const countWords = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const truncateWords = (s, n) => { const w = String(s || '').trim().split(/\s+/); return w.length > n ? w.slice(0, n).join(' ') + '…' : w.join(' '); };

const truncate = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const str = (v, max = 500) => String(Array.isArray(v) ? v[0] : (v ?? '')).trim().slice(0, max);

module.exports = {
  html, raw, esc, Safe, hashPassword, verifyPassword, encrypt, decrypt, maskNin, token, sha256, slugify,
  naira, fmtDate, fmtDateTime, year, computeAge, isoDate, todayISO, nowISO, addDays, displayName, plainName,
  parseCookies, parseMultipart, sniff, truncate, str, MONTHS, toneUrl, countWords, truncateWords, searchTokens, queryWords,
};
