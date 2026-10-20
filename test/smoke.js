// End-to-end smoke test. Starts the app on a throwaway in-memory Firestore-compatible store and walks every
// main flow. It never touches your real Firebase project, even if .env has Firebase credentials.
// Run: npm test
// Also checks that every Firestore query the app runs has an index in firestore.indexes.json.
// After adding new queries, regenerate that file with: npm run indexes
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twm-test-'));
process.env.DATA_DIR = dir;
process.env.PORT = '0';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.PAYSTACK_SECRET_KEY = '';
process.env.TWM_FORCE_LOCAL = '1';
process.env.TWM_LOCAL_MEMORY = '1';
const app = require('../server');
const D = require('../lib/db');
const P = require('../lib/profiles');
const { listen } = require('../lib/app');
const { compositeIndexes } = require('../lib/localstore');

// Database helpers for assertions
const where = async (col, ...pairs) => { let q = D.col(col); for (let i = 0; i < pairs.length; i += 2) q = q.where(pairs[i], '==', pairs[i + 1]); return D.find(q); };
const one = async (col, ...pairs) => (await where(col, ...pairs))[0];
const byId = (col, id) => D.getDoc(col, id);
const userId = async (email) => (await D.getDoc('user_emails', email)).uid;
const payment = (location) => byId('payments', location.split('/').pop());
const ledgerSplit = async (field, id) => {
  const rows = await where('ledger', field, id);
  const out = {}; for (const r of rows) out[r.account] = (out[r.account] || 0) + r.amount; return out;
};
const ASSETS = path.join(__dirname, '..', 'scripts', 'seed-assets');

let BASE;
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const r = await fetch(BASE + url, { method, body, redirect: 'manual', headers: { cookie: this.cookie, ...headers } });
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) { const m = c.match(/twm_sid=([^;]*)/); if (m) this.cookie = m[1] ? `twm_sid=${m[1]}` : ''; }
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location'), text };
  }
  get(url) { return this.req('GET', url); }
  async csrf(url = '/') { const r = await this.get(url); return (r.text.match(/name="_csrf" value="([^"]+)"/) || [])[1]; }
  async post(url, fields, from) {
    const token = await this.csrf(from || url);
    return this.req('POST', url, new URLSearchParams({ _csrf: token, ...fields }), { 'content-type': 'application/x-www-form-urlencoded' });
  }
  async postMultipart(url, fields, files, from) {
    const fd = new FormData();
    fd.append('_csrf', await this.csrf(from || url));
    for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
    for (const [k, list] of Object.entries(files)) for (const f of [].concat(list)) fd.append(k, new Blob([fs.readFileSync(f)]), path.basename(f));
    return this.req('POST', url, fd);
  }
  async follow(r) { while (r.status === 303) r = await this.get(r.location); return r; }
}
const ok = (name) => console.log(`  ✓ ${name}`);

(async () => {
  await app.ready;
  const server = await listen(app, 0);
  BASE = `http://localhost:${server.address().port}`;
  console.log('tillwemeet smoke test');

  // Public pages
  for (const u of ['/', '/memorials', '/memorials/legend', '/how-it-works', '/about', '/charity', '/terms', '/login', '/register']) {
    assert.equal((await new Client().get(u)).status, 200, u);
  }
  ok('public pages load');
  assert.equal((await new Client().get('/create')).status, 303); ok('create requires sign-in');

  // Register creator and visitor
  const creator = new Client(); const visitor = new Client(); const visitor2 = new Client(); const admin = new Client();
  let r = await creator.post('/register', { full_name: 'Ada Creator', email: 'ada@test.local', phone: '08030000001', password: 'password1', password2: 'password1', terms: '1' }, '/register');
  assert.equal(r.status, 303); ok('creator registers');
  await visitor.post('/register', { full_name: 'Vic Visitor', email: 'vic@test.local', phone: '08030000002', password: 'password1', password2: 'password1', terms: '1' }, '/register');
  await visitor2.post('/register', { full_name: 'Val Visitor', email: 'val@test.local', phone: '08030000003', password: 'password1', password2: 'password1', terms: '1' }, '/register');
  r = await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' }, '/login');
  assert.equal(r.status, 303); ok('admin signs in');
  r = await new Client().post('/login', { email: 'ada@test.local', password: 'wrong' }, '/login');
  assert.equal(r.status, 401); ok('wrong password rejected');

  // Validation: missing documents
  const base = {
    category: 'vvip', titles: 'Chief, Dr', first_name: 'Emeka', last_name: 'Test', dob: '1940-03-15', dod: '2026-02-10',
    country: 'Nigeria', state: 'Enugu', lga: 'Nsukka', biography: 'A long life story about a beloved father and teacher who served his community for many decades with joy.',
    epitaph: 'Forever loved', death_cert_number: 'NPC/123', death_cert_authority: 'NPC', uploader_relationship: 'Son', uploader_nin: '12345678901',
    uploader_phone: '08031111111', uploader_address: '1 Test Road, Nsukka', next_of_kin_name: 'Ngozi Test', next_of_kin_phone: '08032222222', attest: '1',
    tone_id: 'amazing-grace', tl_year: ['1962', '1970'], tl_text: ['Graduated', 'Married'], ev_title: ['Funeral service'], ev_date: ['2026-03-01'], ev_time: ['10:00'], ev_venue: ['St Mary, Nsukka'],
  };
  r = await creator.postMultipart('/create', base, {}, '/create');
  assert.equal(r.status, 400); assert.match(r.text, /Attach the death certificate/); ok('missing documents are rejected');
  r = await creator.postMultipart('/create', { ...base, uploader_nin: '123' }, { photo: `${ASSETS}/portrait-01.jpg`, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg` }, '/create');
  assert.match(r.text, /Your NIN has 11 digits/); ok('NIN validated');
  // A fake "image" is refused by content sniffing
  const fake = path.join(dir, 'fake.jpg'); fs.writeFileSync(fake, 'not really an image');
  r = await creator.postMultipart('/create', base, { photo: fake, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg` }, '/create');
  assert.equal(r.status, 400); assert.match(r.text, /file type isn/); ok('file types checked by content');

  // A 3-second video is refused
  const shortVid = path.join(dir, 'short.mp4');
  require('node:child_process').execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=3', '-c:v', 'libx264', shortVid]);
  r = await creator.postMultipart('/create', base, { photo: `${ASSETS}/portrait-01.jpg`, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg`, video: shortVid }, '/create');
  assert.equal(r.status, 400); assert.match(r.text, /15–30 seconds/); ok('video length enforced (15–30s)');

  // Valid VVIP memorial
  r = await creator.postMultipart('/create', base, {
    photo: `${ASSETS}/portrait-01.jpg`, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg`,
    video: `${ASSETS}/demo-video.mp4`, gallery: [`${ASSETS}/portrait-04.jpg`, `${ASSETS}/portrait-05.jpg`],
  }, '/create');
  assert.equal(r.status, 303); assert.match(r.location, /\/payments\/simulate\//);
  const prof = await one('profiles', 'last_name', 'Test');
  assert.equal(prof.status, 'awaiting_payment'); assert.notEqual(prof.uploader_nin_enc, '12345678901'); assert.equal(prof.uploader_nin_last4, '8901');
  assert.equal(Math.round(prof.video_duration), 20);
  ok('VVIP memorial created, NIN encrypted, video accepted');

  // Not public before approval
  assert.equal((await visitor.get(`/m/${prof.slug}`)).status, 404); ok('unapproved memorial hidden from public');

  // Pay listing fee
  r = await creator.post(r.location, { outcome: 'success' }, r.location);
  assert.equal((await byId('profiles', prof.id)).status, 'pending_review');
  assert.equal((await one('payments', 'purpose', 'listing', 'target_id', prof.id)).amount, 200000);
  ok('listing fee ₦200,000 paid, memorial in review');

  // Admin review and approve
  r = await admin.get(`/admin/memorials/${prof.id}`);
  assert.equal(r.status, 200); assert.match(r.text, /Reveal \(logged\)/); assert.doesNotMatch(r.text, /12345678901/);
  r = await admin.get(`/admin/memorials/${prof.id}?nin=1`); assert.match(r.text, /12345678901/); ok('admin sees documents; NIN reveal is audited');
  const certFile = prof.death_cert;
  assert.equal((await visitor.get(`/admin/files/${certFile}`)).status, 403); ok('private documents blocked for non-admins');
  assert.equal((await new Client().get(`/media/${certFile}`)).status, 404); ok('private documents not served publicly');
  await admin.post(`/admin/memorials/${prof.id}/approve`, {}, `/admin/memorials/${prof.id}`);
  assert.equal((await byId('profiles', prof.id)).status, 'approved'); ok('admin approves');
  assert.ok((await D.find(D.col('audit_log'))).some((a) => a.action === 'nin.view'));

  // Public view: bio gated for signed-out visitors
  r = await new Client().get(`/m/${prof.slug}`);
  assert.equal(r.status, 200); assert.match(r.text, /Sign in to read the life story/); assert.doesNotMatch(r.text, /beloved father and teacher/);
  r = await visitor.get(`/m/${prof.slug}`);
  assert.match(r.text, /beloved father and teacher/); assert.match(r.text, /85 years/); assert.match(r.text, /A moment with Emeka/); assert.match(r.text, /data-tone=/);
  ok('biography only for signed-in users; age calculated (85 years); video and tone shown');
  r = await new Client().get('/'); assert.match(r.text, /Emeka Test/); ok('approved memorial on homepage');

  // Tribute: ₦20,000 for VVIP, split 40/40/20
  r = await visitor.post(`/m/${prof.slug}/tribute`, { message: 'You taught half the town to read. Rest well, sir.', relationship: 'Student' }, `/m/${prof.slug}`);
  assert.match(r.location, /simulate/);
  await visitor.post(r.location, { outcome: 'success' }, r.location);
  const tid = `${prof.id}_${await userId('vic@test.local')}`;
  assert.deepEqual(await ledgerSplit('tribute_id', tid), { charity: 8000, creator: 8000, platform: 4000 });
  ok('tribute ₦20,000 split: ₦8,000 creator, ₦8,000 charity, ₦4,000 platform');
  r = await visitor.post(`/m/${prof.slug}/tribute`, { message: 'Trying to leave a second tribute here.' }, `/m/${prof.slug}`);
  assert.match((await visitor.follow(r)).text, /already left a tribute/);
  assert.equal((await where('tributes', 'profile_id', prof.id, 'user_id', await userId('vic@test.local'))).length, 1);
  ok('one tribute per user per memorial');
  // Two tributes sent at the same moment by the same person still produce one
  const racer = new Client();
  await racer.post('/register', { full_name: 'Rae Racer', email: 'rae@test.local', phone: '08030000009', password: 'password1', password2: 'password1', terms: '1' }, '/register');
  const tok = await racer.csrf(`/m/${prof.slug}`);
  const send = (m) => racer.req('POST', `/m/${prof.slug}/tribute`, new URLSearchParams({ _csrf: tok, message: m }), { 'content-type': 'application/x-www-form-urlencoded' });
  const [ra, rb] = await Promise.all([send('First of two tributes sent at once, this one.'), send('Second of two tributes sent at once, that one.')]);
  for (const x of [ra, rb]) if (/simulate/.test(x.location || '')) await racer.post(x.location, { outcome: 'success' }, x.location);
  assert.equal((await where('tributes', 'profile_id', prof.id, 'user_id', await userId('rae@test.local'), 'status', 'published')).length, 1);
  ok('simultaneous tributes from one person still make one');
  r = await creator.post(`/m/${prof.slug}/tribute`, { message: 'Creator trying to tribute own memorial.' }, `/m/${prof.slug}`);
  assert.equal(r.status, 400); ok('creator cannot tribute own memorial');
  r = await new Client().get(`/m/${prof.slug}`); assert.match(r.text, /You taught half the town to read/); ok('tribute visible with share links');
  r = await new Client().get(`/t/${tid}`); assert.equal(r.status, 200); assert.match(r.text, /og:image/); assert.match(r.text, /wa\.me/); ok('tribute share page has social preview and WhatsApp link');

  // Tribute word limit (VVIP: 1,500 words)
  r = await visitor2.post(`/m/${prof.slug}/tribute`, { message: 'word '.repeat(1501) }, `/m/${prof.slug}`);
  r = await visitor2.follow(r);
  assert.match(r.text, /1501 words/); assert.match(r.text, /up to 1500 words/);
  assert.equal((await where('tributes', 'profile_id', prof.id, 'user_id', await userId('val@test.local'))).length, 0);
  ok('VVIP tribute over 1,500 words refused (draft kept)');

  // Flowers: ₦50,000 on VVIP, any number of times, note up to 160 words
  r = await visitor.post(`/m/${prof.slug}/flower`, { flower: 'lily', note: 'word '.repeat(161) }, `/m/${prof.slug}`);
  assert.match((await visitor.follow(r)).text, /161 words/); ok('flower note over 160 words refused');
  r = await visitor.post(`/m/${prof.slug}/flower`, { flower: 'lily', note: 'Rest well, sir. You taught me to read.' }, `/m/${prof.slug}`);
  assert.equal((await payment(r.location)).amount, 50000);
  r = await visitor.post(r.location, { outcome: 'success' }, r.location);
  assert.match(r.location, /^\/f\/[A-Za-z0-9]+\?new=1$/);
  const fid = r.location.match(/^\/f\/([A-Za-z0-9]+)/)[1];
  assert.deepEqual(await ledgerSplit('flower_id', fid), { charity: 20000, creator: 20000, platform: 10000 });
  ok('VVIP flower ₦50,000 split 40/40/20');
  r = await visitor.get(r.location); assert.match(r.text, /Your flower has been laid/); assert.match(r.text, /Download card/);
  r = await new Client().get(`/f/${fid}/card.svg`);
  assert.equal(r.status, 200); assert.match(r.text, /^<svg/); assert.match(r.text, /laid a white lily/); assert.match(r.text, /data:image\/jpeg;base64/);
  ok('flower card page and downloadable card render');
  r = await visitor.post(`/m/${prof.slug}/flower`, { flower: 'rose' }, `/m/${prof.slug}`);
  await visitor.post(r.location, { outcome: 'success' }, r.location);
  assert.equal((await where('flowers', 'profile_id', prof.id, 'status', 'published')).length, 2); ok('visitors can lay flowers more than once');
  r = await new Client().get(`/m/${prof.slug}`);
  assert.match(r.text, /Vic Visitor<\/strong> laid a red rose/); assert.match(r.text, /<strong>2<\/strong> flowers/); assert.match(r.text, /<strong>2<\/strong> tributes/);
  r = await new Client().get('/'); assert.match(r.text, /Flowers: <\/span>2/);
  ok('flower list public; tribute and flower counts on page and headstone card');
  assert.equal((await new Client().get(`/m/${prof.slug}/flowers`)).status, 200);

  // Candle
  await visitor.post(`/m/${prof.slug}/candle`, {}, `/m/${prof.slug}`);
  await visitor.post(`/m/${prof.slug}/candle`, {}, `/m/${prof.slug}`);
  assert.equal((await byId('profiles', prof.id)).candles, 1); ok('one candle per visitor');

  // Edit rules: first edit anytime, then 90 days
  r = await creator.postMultipart(`/account/memorials/${prof.id}/edit`, { ...base, epitaph: 'Forever loved, never forgotten' }, {}, `/account/memorials/${prof.id}/edit`);
  assert.equal(r.status, 303);
  assert.equal((await byId('profiles', prof.id)).edit_count, 1);
  assert.equal((await byId('profiles', prof.id)).epitaph, 'Forever loved'); // not applied until reviewed
  ok('first edit allowed and sent for review');
  const rev = await one('revisions', 'profile_id', prof.id, 'status', 'pending');
  await admin.post(`/admin/edits/${rev.id}/approve`, {}, `/admin/edits/${rev.id}`);
  assert.equal((await byId('profiles', prof.id)).epitaph, 'Forever loved, never forgotten'); ok('admin applies the edit');
  r = await creator.get(`/account/memorials/${prof.id}/edit`);
  assert.equal(r.status, 303); assert.match((await creator.follow(r)).text, /next edit opens on/); ok('second edit blocked for 90 days');
  r = await creator.postMultipart(`/account/memorials/${prof.id}/edit`, base, {}, `/account/memorials/${prof.id}`);
  assert.equal(r.status, 403); ok('server enforces the 90-day rule');
  await D.col('profiles').doc(prof.id).update({ last_edit_at: new Date(Date.now() - 91 * 86400000).toISOString().replace('T', ' ').slice(0, 19) });
  assert.equal((await creator.get(`/account/memorials/${prof.id}/edit`)).status, 200); ok('edit reopens after 90 days');

  // Legend: admin only
  r = await creator.postMultipart('/create', { ...base, category: 'legend' }, { photo: `${ASSETS}/portrait-01.jpg`, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg` }, '/create');
  assert.equal(r.status, 400); assert.match(r.text, /Choose Regular, VIP or VVIP/); ok('users cannot choose Legend');
  await admin.post(`/admin/memorials/${prof.id}/legend`, { on: '1' }, `/admin/memorials/${prof.id}`);
  assert.equal((await byId('profiles', prof.id)).category, 'legend'); ok('admin names a Legend');
  r = await new Client().get('/'); assert.match(r.text, /stone--legend[^]*Emeka Test/); ok('Legend shows in the Legends row');
  await admin.post(`/admin/memorials/${prof.id}/legend`, { on: '0' }, `/admin/memorials/${prof.id}`);
  assert.equal((await byId('profiles', prof.id)).category, 'vvip'); ok('Legend status can be removed');

  // Regular memorial + upgrade to VIP pays the difference
  const reg = { ...base, category: 'regular', first_name: 'Bisi', last_name: 'Regular' };
  r = await creator.postMultipart('/create', reg, { photo: `${ASSETS}/portrait-06.jpg`, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg` }, '/create');
  await creator.post(r.location, { outcome: 'success' }, r.location);
  const rp = await one('profiles', 'last_name', 'Regular');
  assert.equal(rp.listing_amount, 10000); assert.equal(rp.tone_id, null); assert.deepEqual(rp.timeline, []);
  ok('Regular costs ₦10,000; premium fields ignored');
  await admin.post(`/admin/memorials/${rp.id}/approve`, {}, `/admin/memorials/${rp.id}`);
  r = await creator.post(`/account/memorials/${rp.id}/upgrade`, { to: 'vip' }, `/account/memorials/${rp.id}`);
  assert.equal((await payment(r.location)).amount, 40000);
  await creator.post(r.location, { outcome: 'success' }, r.location);
  assert.equal((await byId('profiles', rp.id)).category, 'vip'); ok('upgrade Regular → VIP charges ₦40,000');
  r = await visitor.post(`/m/${rp.slug}/flower`, { flower: 'marigold' }, `/m/${rp.slug}`);
  assert.equal((await payment(r.location)).amount, 10000); ok('VIP flower costs ₦10,000');
  r = await visitor2.post(`/m/${rp.slug}/tribute`, { message: 'word '.repeat(501) }, `/m/${rp.slug}`);
  assert.equal(r.status, 303); assert.match((await visitor2.follow(r)).text, /up to 500 words/); ok('VIP tribute limited to 500 words');
  r = await visitor2.post(`/m/${rp.slug}/tribute`, { message: 'A wonderful neighbour, always smiling.' }, `/m/${rp.slug}`);
  assert.equal((await payment(r.location)).amount, 5000); ok('VIP tribute costs ₦5,000');
  await visitor2.post(r.location, { outcome: 'fail' }, r.location);
  assert.equal((await one('tributes', 'profile_id', rp.id)).status, 'pending_payment'); ok('cancelled payment leaves tribute unpublished');

  // Earnings and withdrawal
  r = await creator.get('/account/earnings'); assert.match(r.text, /₦8,000/); assert.match(r.text, /Flower/);
  await creator.post('/account/settings', { full_name: 'Ada Creator', phone: '0803', bank_name: 'GTBank', account_number: '0123456789', account_name: 'Ada Creator' }, '/account/settings');
  r = await creator.post('/account/withdraw', { amount: '99000' }, '/account/earnings'); assert.equal(r.status, 400);
  const creatorId = await userId('ada@test.local');
  const balance = (await byId('users', creatorId)).earned;
  // Two withdrawals of the whole balance sent at once: only one can succeed
  const wtok = await creator.csrf('/account/earnings');
  const wd = () => creator.req('POST', '/account/withdraw', new URLSearchParams({ _csrf: wtok, amount: String(Math.floor(balance)) }), { 'content-type': 'application/x-www-form-urlencoded' });
  const results = await Promise.all([wd(), wd()]);
  assert.deepEqual(results.map((x) => x.status).sort(), [303, 400]);
  assert.equal((await where('withdrawals', 'user_id', creatorId)).length, 1);
  ok('simultaneous withdrawals can’t overdraw the balance');
  const w = await one('withdrawals', 'user_id', creatorId);
  await admin.post(`/admin/withdrawals/${w.id}`, { action: 'paid', note: 'TRF-1' }, '/admin/withdrawals');
  assert.equal((await byId('withdrawals', w.id)).status, 'paid'); assert.equal((await byId('users', creatorId)).paid_out, Math.floor(balance));
  ok('creator withdraws 40% share; admin marks paid');

  // Regular tribute limit 250 words, regular flower ₦2,000
  const reg2 = { ...base, category: 'regular', first_name: 'Chidi', last_name: 'Plain' };
  r = await creator.postMultipart('/create', reg2, { photo: `${ASSETS}/portrait-07.jpg`, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg` }, '/create');
  await creator.post(r.location, { outcome: 'success' }, r.location);
  const rp2 = await one('profiles', 'last_name', 'Plain');
  await admin.post(`/admin/memorials/${rp2.id}/approve`, {}, `/admin/memorials/${rp2.id}`);
  r = await visitor.post(`/m/${rp2.slug}/tribute`, { message: 'word '.repeat(251) }, `/m/${rp2.slug}`);
  assert.match((await visitor.follow(r)).text, /up to 250 words/);
  r = await visitor.post(`/m/${rp2.slug}/tribute`, { message: 'word '.repeat(250) }, `/m/${rp2.slug}`);
  assert.match(r.location, /simulate/); ok('Regular tribute limited to 250 words');
  r = await visitor.post(`/m/${rp2.slug}/flower`, { flower: 'carnation' }, `/m/${rp2.slug}`);
  assert.equal((await payment(r.location)).amount, 2000); ok('Regular flower costs ₦2,000');

  // Same name and year of death: each memorial still gets its own address
  r = await creator.postMultipart('/create', { ...reg2 }, { photo: `${ASSETS}/portrait-07.jpg`, death_cert: `${ASSETS}/sample-certificate.png`, uploader_photo: `${ASSETS}/portrait-02.jpg` }, '/create');
  const plains = await where('profiles', 'last_name', 'Plain');
  assert.equal(plains.length, 2); assert.notEqual(plains[0].slug, plains[1].slug); ok('memorial web addresses stay unique');

  // Moderation
  await creator.post(`/tributes/${tid}/report`, { reason: 'test' }, `/account/memorials/${prof.id}`);
  assert.equal((await byId('tributes', tid)).reported, true);
  r = await admin.get('/admin/tributes?reported=1'); assert.match(r.text, /You taught half the town/);
  const before = (await byId('profiles', prof.id)).tribute_count;
  await admin.post(`/admin/tributes/${tid}/toggle`, {}, '/admin/tributes');
  r = await new Client().get(`/m/${prof.slug}`); assert.doesNotMatch(r.text, /You taught half the town/);
  assert.equal((await byId('profiles', prof.id)).tribute_count, before - 1);
  ok('reported tribute hidden by admin; counts updated');

  await admin.post(`/admin/flowers/${fid}/toggle`, {}, '/admin/flowers');
  assert.equal((await new Client().get(`/f/${fid}`)).status, 404); ok('admin can hide a flower');

  // Charity disbursement and pricing
  const charityId = (await D.find(D.col('charities')))[0].id;
  await admin.post('/admin/charity/disburse', { charity_id: charityId, amount: '5000', reference: 'X' }, '/admin/charity');
  assert.equal((await D.find(D.col('charity_disbursements'))).reduce((a, d) => a + d.amount, 0), 5000);
  r = await admin.post('/admin/charity/disburse', { charity_id: charityId, amount: '999999' }, '/admin/charity'); assert.equal(r.status, 400);
  ok('charity disbursement limited to the balance');
  await admin.post('/admin/settings', { listing_regular: '12000', tribute_regular: '1500', listing_vip: '50000', tribute_vip: '5000', listing_vvip: '200000', tribute_vvip: '20000', tribute_legend: '20000' }, '/admin/settings');
  assert.equal(D.prices('regular').listingFee, 12000); ok('admin can change prices');

  // Running totals match the ledger
  const stats = await D.getStats(); const ledger = await D.find(D.col('ledger'));
  const sum = (acct) => ledger.filter((l) => l.account === acct).reduce((a, l) => a + l.amount, 0);
  assert.equal(stats.charity_total, sum('charity')); assert.equal(stats.creator_total, sum('creator')); assert.equal(stats.platform_total, sum('platform'));
  assert.equal(stats.gross, (await where('payments', 'status', 'success')).reduce((a, p) => a + p.amount, 0));
  ok('platform totals match the ledger');

  // Every admin page renders
  for (const u of ['/admin', '/admin/review', '/admin/edits', '/admin/memorials', '/admin/tributes', '/admin/flowers', '/admin/users', '/admin/payments', '/admin/withdrawals', '/admin/charity', '/admin/tones', '/admin/settings', '/admin/audit', `/admin/users/${creatorId}`,
    '/admin/memorials?status=approved', '/admin/memorials?category=vip', '/admin/memorials?status=approved&category=vvip', '/admin/memorials?q=emeka', '/admin/memorials?q=ada@test.local', '/admin/memorials?q=emeka&status=approved&category=vvip',
    '/admin/memorials?q=emeka&status=approved', '/admin/memorials?q=emeka&category=vvip', '/admin/memorials?q=ada@test.local&status=approved', '/admin/memorials?q=ada@test.local&category=vip', '/admin/memorials?q=ada@test.local&status=approved&category=vip',
    '/admin/payments?status=success', '/admin/payments?purpose=tribute', '/admin/payments?status=success&purpose=flower',
    '/admin/tributes?q=vic', '/admin/flowers?q=vic', '/admin/users?q=ada', '/admin/users?q=ada@test.local', '/admin/audit?page=2', `/admin/edits/${rev.id}`]) {
    assert.equal((await admin.get(u)).status, 200, u);
  }
  assert.equal((await visitor.get('/admin')).status, 403);
  ok('admin dashboard pages render; non-admins blocked');
  for (const u of ['/account', '/account/earnings', '/account/tributes', '/account/flowers', '/account/settings', `/account/memorials/${prof.id}`, `/m/${prof.slug}/programme`]) assert.equal((await creator.get(u)).status, 200, u);
  assert.equal((await visitor.get(`/account/memorials/${prof.id}`)).status, 404);
  ok('account pages render; other users cannot manage the memorial');

  // ---------- Search and filters ----------
  const mk = async (o) => {
    const { id } = await P.createProfile({
      creator_id: creatorId, creator_name: 'Ada Creator', category: o.category || 'regular', titles: o.titles || '', first_name: o.first, middle_name: '', last_name: o.last,
      nickname: o.nickname || '', gender: '', dob: o.dob, dod: o.dod, country: o.country, state: o.state, lga: o.lga, biography: 'x'.repeat(90), epitaph: '', survivors: '',
      photo: null, tone_id: null, gallery: [], timeline: [], service_events: [],
    });
    await D.col('profiles').doc(id).update({ status: o.status || 'approved', approved_at: D.now() });
    return id;
  };
  await mk({ first: 'Folake', last: 'Okafor', dob: '1950-06-01', dod: '2019-03-02', country: 'Nigeria', state: 'Lagos', lga: 'Ikeja' });
  await mk({ first: 'Tamuno', last: 'Briggs', nickname: 'Papa T', dob: '1962-01-20', dod: '2024-08-09', country: 'Nigeria', state: 'Rivers', lga: 'Obio/Akpor', category: 'vip' });
  await mk({ first: 'Kwame', last: 'Mensah', dob: '1950-11-11', dod: '2024-01-15', country: 'Ghana', state: 'Greater Accra', lga: 'Accra Metropolitan' });
  await mk({ first: 'Hidden', last: 'Okafor', dob: '1950-01-01', dod: '2019-01-01', country: 'Nigeria', state: 'Lagos', lga: 'Ikeja', status: 'pending_review' });
  D.bustCache();
  const names = (text) => [...text.matchAll(/class="stone__name">([^<]+)</g)].map((m) => m[1].trim()).sort();
  const search = async (qsx, path = '/memorials') => { const res = await new Client().get(`${path}?${qsx}`); assert.equal(res.status, 200, qsx); return res.text; };

  assert.deepEqual(names(await search('q=okafor')), ['Folake Okafor']); ok('search by surname (unpublished memorials never show)');
  assert.deepEqual(names(await search('q=papa')), ['Tamuno Briggs']); ok('search by nickname');
  assert.deepEqual(names(await search('q=tam+bri')), ['Tamuno Briggs']); ok('search by several partial names');
  assert.deepEqual(names(await search('year=2024')), ['Kwame Mensah', 'Tamuno Briggs']); ok('filter by year of death');
  assert.deepEqual(names(await search('year=1950&yearType=born')), ['Folake Okafor', 'Kwame Mensah']); ok('filter by year of birth');
  assert.ok(names(await search('year=2020s')).includes('Emeka Test') && !names(await search('year=2020s')).includes('Folake Okafor')); ok('filter by decade');
  assert.deepEqual(names(await search('country=Ghana')), ['Kwame Mensah']); ok('filter by country');
  assert.deepEqual(names(await search('country=Nigeria&state=Lagos')), ['Folake Okafor']); ok('filter by state');
  assert.deepEqual(names(await search('state=rivers&lga=obio-akpor')), ['Tamuno Briggs']); ok('filter by LGA (spelling and case don’t matter)');
  assert.deepEqual(names(await search('q=okafor&year=2019&state=Lagos&lga=Ikeja')), ['Folake Okafor']); ok('name, year and location together');
  assert.deepEqual(names(await search('year=2024', '/memorials/vip')), ['Tamuno Briggs']); ok('filters work inside a category');
  assert.deepEqual(names(await search('q=okafor&year=2024')), []);
  r = await new Client().get('/memorials?q=okafor&year=2024'); assert.match(r.text, /No memorials match these filters/); assert.match(r.text, /Try the whole decade/); ok('helpful empty state');
  r = await new Client().get('/memorials?state=Nigeria'); assert.ok(names(r.text).includes('Folake Okafor')); ok('older ?state=Country links still work');
  r = await new Client().get('/memorials?year=abcd&country=Ghana'); assert.deepEqual(names(r.text), ['Kwame Mensah']); ok('invalid year is ignored');
  r = await new Client().get('/memorials?year=2024&country=Nigeria&sort=died');
  assert.match(r.text, /Died in 2024/); assert.match(r.text, /href="\/memorials\?country=Nigeria&amp;sort=died"/); ok('active filters show as chips that remove themselves');
  r = await new Client().get('/memorials?sort=died&country=Nigeria');
  const dods = [...r.text.matchAll(/class="stone__years">(\d{4}) – (\d{4})</g)].map((m) => Number(m[2]));
  assert.deepEqual(dods, [...dods].sort((a, b) => b - a)); ok('sort by date of death');
  r = await new Client().get('/api/memorials/suggest?q=tam');
  const sug = JSON.parse(r.text).results; assert.equal(sug[0].name, 'Tamuno Briggs'); assert.match(sug[0].url, /^\/m\//); ok('name suggestions as you type');
  r = await new Client().get('/api/places?country=Nigeria&state=Lagos'); const pl = JSON.parse(r.text);
  assert.ok(pl.states.includes('Lagos') && pl.lgas.includes('Ikeja')); ok('state and LGA suggestions');
  r = await new Client().get('/api/places?country=Ghana'); assert.deepEqual(JSON.parse(r.text).states, ['Greater Accra']);
  r = await visitor.get(`/m/${prof.slug}`); assert.match(r.text, /href="\/memorials\?year=2026"/); assert.match(r.text, /href="\/memorials\?country=Nigeria&amp;state=Enugu&amp;lga=Nsukka"/);
  ok('memorial pages link the year and places to searches');
  // Reindex rebuilds search keys for memorials saved before search existed
  await D.col('profiles').doc(prof.id).update({ filterKeys: [] });
  await (async () => { const rows = await D.find(D.col('profiles')); for (const p of rows) await D.col('profiles').doc(p.id).update(P.derived(p)); })();
  assert.ok((await byId('profiles', prof.id)).filterKeys.includes('l:nsukka')); ok('search keys can be rebuilt');
  for (const u of ['/memorials?q=emeka', '/memorials?q=emeka+test', '/memorials?state=Enugu', '/memorials/vvip?q=em&sort=name']) assert.equal((await new Client().get(u)).status, 200, u);
  r = await new Client().get('/memorials?q=oke'); assert.doesNotMatch(r.text, /Emeka Test/);
  r = await new Client().get('/memorials?q=tes'); assert.match(r.text, /Emeka Test/); ok('search by name prefix works');
  // Run every filter shape and sort, in and out of a category, so each query's index is checked below
  const S = require('../lib/search');
  for (const category of [null, 'vip']) {
    for (const extra of [{}, { lga: 'Ikeja' }, { lga: 'Ikeja', year: '2019' }]) for (const sort of Object.keys(S.SORTS)) { D.bustCache(); await S.searchMemorials({ category, sort, ...extra, limit: 5 }); }
  }
  ok('all memorial list filters and sorts run');

  // Every query must have its Firestore index
  const needed = compositeIndexes([...D.db.queryShapes.values()]);
  const indexFile = path.join(__dirname, '..', 'firestore.indexes.json');
  if (process.argv.includes('--write-indexes')) {
    fs.writeFileSync(indexFile, JSON.stringify({ indexes: needed, fieldOverrides: [] }, null, 2) + '\n');
    console.log(`  wrote ${needed.length} composite indexes to firestore.indexes.json`);
  } else {
    const have = new Set(JSON.parse(fs.readFileSync(indexFile, 'utf8')).indexes.map((i) => JSON.stringify(i)));
    const missing = needed.filter((i) => !have.has(JSON.stringify(i)));
    assert.equal(missing.length, 0, `Missing Firestore indexes, run "npm run indexes":\n${JSON.stringify(missing, null, 1)}`);
    ok(`all ${needed.length} composite indexes are in firestore.indexes.json`);
  }

  // CSRF
  r = await creator.req('POST', '/account/withdraw', new URLSearchParams({ amount: '1000' }), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 403); ok('requests without a CSRF token are refused');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('All checks passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
