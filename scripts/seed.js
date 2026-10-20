// Fills the database with fictional demo memorials, users, tributes and flowers.
// Works on real Firestore, the emulator, or the local store.
// Usage: npm run seed            (refuses to run twice)
//        npm run seed -- --force (adds another batch)
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config');
const D = require('../lib/db');
const pay = require('../lib/payments');
const storage = require('../lib/storage');
const { encrypt, token, nowISO, searchTokens } = require('../lib/util');
const P = require('../lib/profiles');
const { createUser, findByEmail } = require('../lib/users');
const app = require('../server');

const ASSETS = path.join(__dirname, 'seed-assets');
const copy = async (file, vis) => {
  const name = `${token(12)}${path.extname(file)}`;
  await storage.put(vis, name, fs.readFileSync(path.join(ASSETS, file)));
  return name;
};

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const F = ['Adaeze', 'Funmilayo', 'Ngozi', 'Aisha', 'Bolanle', 'Chiamaka', 'Halima', 'Ifeoma', 'Kemi', 'Nkechi', 'Omolara', 'Ronke', 'Titilayo', 'Uche', 'Yetunde', 'Zainab', 'Ebere', 'Folake', 'Grace', 'Patience', 'Comfort', 'Blessing'];
const M = ['Chukwuemeka', 'Adewale', 'Babatunde', 'Ibrahim', 'Obinna', 'Olumide', 'Musa', 'Emeka', 'Tunde', 'Segun', 'Kelechi', 'Abubakar', 'Ikenna', 'Femi', 'Nnamdi', 'Yakubu', 'Godwin', 'Sunday', 'Okon', 'Effiong', 'Ebuka', 'Gbenga'];
const S = ['Okafor', 'Adeyemi', 'Bello', 'Eze', 'Ogunleye', 'Nwosu', 'Abubakar', 'Okonkwo', 'Balogun', 'Danjuma', 'Etim', 'Ibekwe', 'Lawal', 'Nwachukwu', 'Ojo', 'Oyelaran', 'Uzoma', 'Akpan', 'Ike', 'Fashola', 'Amadi', 'Bassey', 'Olawale', 'Chukwu'];
const PLACES = [['Lagos', 'Ikeja'], ['Lagos', 'Surulere'], ['Rivers', 'Obio/Akpor'], ['Anambra', 'Onitsha North'], ['Enugu', 'Nsukka'], ['Oyo', 'Ibadan North'], ['Kano', 'Nassarawa'], ['FCT Abuja', 'Abuja Municipal'], ['Imo', 'Owerri Municipal'], ['Akwa Ibom', 'Uyo'], ['Ogun', 'Abeokuta South'], ['Kaduna', 'Kaduna North'], ['Edo', 'Oredo'], ['Delta', 'Warri South'], ['Cross River', 'Calabar Municipal']];
const WORK = ['taught mathematics for thirty years', 'ran a busy fabric shop in the main market', 'served as a nurse at the general hospital', 'built a transport business from a single bus', 'worked as a civil engineer on roads across the state', 'led the church choir for two decades', 'farmed cassava and yam and fed half the village', 'practised law and mentored young lawyers', 'kept the community pharmacy open through every crisis', 'ran a primary school loved by generations of pupils'];
const TRAITS = ['quick laugh', 'patience with children', 'generous table', 'steady advice', 'love of highlife music', 'Sunday jollof', 'stories about the old days', 'faith', 'sharp sense of humour', 'habit of helping strangers'];

function bio(first, place, female) {
  const he = female ? 'She' : 'He'; const his = female ? 'her' : 'his';
  return `${first} was born and raised in ${place[1]}, ${place[0]} State, the ${pick(['first', 'second', 'third', 'last'])} of ${3 + Math.floor(rnd() * 6)} children. ${he} ${pick(WORK)}.\n\n` +
    `Family and friends remember ${his} ${pick(TRAITS)}, ${his} ${pick(TRAITS)} and the way ${he.toLowerCase()} made every visitor feel expected. ${he} never missed a wedding, a naming ceremony or a chance to give advice nobody asked for, and was usually right.\n\n` +
    `${he} leaves behind a family that will keep ${his} memory alive, and a community that is better for having known ${female ? 'her' : 'him'}. Sleep well. Till we meet again.`;
}

function dateBetween(y1, y2) {
  const y = y1 + Math.floor(rnd() * (y2 - y1 + 1));
  return `${y}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
}

// ---- users ----
const users = new Map();
const mkUser = async (email, name, role = 'user', pw = 'demo12345') => {
  const ex = await findByEmail(email);
  const id = ex ? ex.id : await createUser({ email, password: pw, full_name: name, phone: '0803' + Math.floor(1000000 + rnd() * 8999999), role });
  users.set(id, { id, email, full_name: ex ? ex.full_name : name });
  return id;
};
const adminPw = config.adminPassword || 'tillwemeet-admin';

/** Records a simulated payment and applies it exactly as a real one would be. */
async function paid(userId, purpose, targetId, amount, meta) {
  const u = users.get(userId);
  const reference = `SEED-${purpose.slice(0, 3).toUpperCase()}-${token(5)}`.toUpperCase();
  await D.col('payments').doc(reference).create({
    reference, user_id: u.id, user_name: u.full_name, user_email: u.email, purpose, target_id: targetId, meta: meta || null, amount,
    status: 'pending', provider: 'simulated', provider_response: null, success_path: '/', cancel_path: '/', created_at: nowISO(), verified_at: null,
  });
  await pay.fulfil(reference);
}
const TRIBUTES = [
  'You taught me that kindness costs nothing and returns everything. I will carry your lessons into every classroom I stand in.',
  'Rest well. Your laughter filled every room you entered, and the house is too quiet without you.',
  'Thank you for paying my school fees when no one else would. Everything I have built started with your belief in me.',
  'We will miss your Sunday rice and your stories about the old days. Sleep well until we meet again.',
  'A true pillar of our community. Your door was always open and your advice was always honest.',
  'You were a father to many of us on that street. We remember, and we are grateful.',
  'Mummy, the choir sang your favourite hymn today. We felt you with us. Rest in perfect peace.',
  'Gone too soon, but never forgotten. Your work at the hospital saved more lives than anyone will ever count.',
  'I still hear your voice telling me to finish what I start. I finished, sir. Thank you.',
  'Your generosity built a church, a school and a hundred futures. Thank you for showing us how to live.',
];

async function makeProfile({ category, status = 'approved', featured = 0, idx }, ctx) {
  const { creators, visitors, tones } = ctx;
  const female = idx % 2 === 0;
  const first = female ? pick(F) : pick(M); const last = pick(S);
  const place = pick(PLACES);
  const dob = dateBetween(1932, 1985); const dod = dateBetween(2019, 2026) > '2026-10-10' ? '2026-08-14' : dateBetween(2019, 2026);
  const titles = pick(female ? ['Mrs', 'Chief (Mrs)', 'Deaconess', 'Dr', 'Lolo', 'Alhaja', 'Mrs', 'Prof'] : ['Mr', 'Chief', 'Engr', 'Dr', 'Pastor', 'Alhaji', 'Barr', 'Prof', 'Sir', 'Hon']);
  const cat = config.categories[category];
  const portrait = `portrait-${String(idx % 24).padStart(2, '0')}.jpg`;
  const gallery = cat.gallery ? await Promise.all(Array.from({ length: Math.min(cat.gallery, category === 'vip' ? 4 : 6) }, (_, k) => copy(`portrait-${String((idx + k * 5 + 1) % 24).padStart(2, '0')}.jpg`, 'public'))) : [];
  const rank = cat.rank;
  const timeline = rank >= 3 ? [
    { year: String(Number(dob.slice(0, 4)) + 22), text: 'Graduated from the University of Nigeria, Nsukka' },
    { year: String(Number(dob.slice(0, 4)) + 27), text: 'Married the love of their life' },
    { year: String(Number(dob.slice(0, 4)) + 35), text: 'Founded the family business' },
    { year: String(Number(dob.slice(0, 4)) + 55), text: 'Honoured with a chieftaincy title by the community' },
  ].filter((t) => t.year < dod.slice(0, 4)) : [];
  const events = rank >= 3 ? [
    { title: 'Wake keeping', date: '2026-11-05', time: '18:00', venue: `Family compound, ${place[1]}, ${place[0]}` },
    { title: 'Funeral service', date: '2026-11-06', time: '10:00', venue: `St. Peter's Cathedral, ${place[1]}` },
    { title: 'Interment', date: '2026-11-06', time: '13:00', venue: 'Family residence' },
    { title: 'Outing service and reception', date: '2026-11-08', time: '09:00', venue: `Town hall, ${place[1]}` },
  ] : [];
  const owner = creators[idx % creators.length];
  const created = new Date(Date.now() - idx * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const { id } = await P.createProfile({
    creator_id: owner, creator_name: users.get(owner).full_name, category: category === 'legend' ? 'vvip' : category,
    titles, first_name: first, middle_name: '', last_name: last, nickname: '', gender: female ? 'Female' : 'Male', dob, dod,
    country: 'Nigeria', state: place[0], lga: place[1], place_of_death: `${place[1]} General Hospital`, cause_of_death: '',
    burial_date: null, burial_place: `Family compound, ${place[1]}`, biography: bio(first, place, female),
    epitaph: rank >= 2 ? pick(['Forever in our hearts', 'A life well lived', 'Gone home to rest', 'Loved beyond words, missed beyond measure', 'Your light still guides us']) : '',
    survivors: rank >= 3 ? `Survived by ${female ? 'her husband' : 'his wife'}, ${2 + (idx % 5)} children, ${4 + (idx % 9)} grandchildren and many relatives.` : '',
    photo: await copy(portrait, 'public'), tone_id: rank >= 2 && tones.length ? pick(tones).id : null,
    video: rank >= 3 && fs.existsSync(path.join(ASSETS, 'demo-video.mp4')) && idx % 2 === 1 ? await copy('demo-video.mp4', 'public') : null, video_duration: rank >= 3 ? 20 : null,
    gallery, timeline, service_events: events,
    death_cert: await copy('sample-certificate.png', 'private'), death_cert_number: `NPC/${place[0].slice(0, 3).toUpperCase()}/${100000 + idx}`, death_cert_authority: 'National Population Commission',
    uploader_relationship: pick(['Son', 'Daughter', 'Spouse', 'Nephew']), uploader_nin_enc: encrypt('12345678' + String(100 + idx).slice(-3)), uploader_nin_last4: String(100 + idx).slice(-3).padStart(4, '8'),
    uploader_photo: await copy(`portrait-${String((idx + 7) % 24).padStart(2, '0')}.jpg`, 'private'), uploader_id_doc: null,
    uploader_phone: '08030000000', uploader_address: `${10 + idx} Allen Avenue, Ikeja`, next_of_kin_name: 'Chinedu Okonkwo', next_of_kin_phone: '08090000000',
    attested_at: created, created_at: created, featured,
  });
  if (status !== 'awaiting_payment') await paid(owner, 'listing', id, D.prices(category === 'legend' ? 'vvip' : category).listingFee);
  const finalStatus = { status, approved_at: status === 'approved' ? `2026-0${1 + (idx % 9)}-1${idx % 9} 10:00:00` : null };
  if (category === 'legend') Object.assign(finalStatus, { category: 'legend', previous_category: 'vvip', legend_since: nowISO() });
  await D.col('profiles').doc(id).update(finalStatus);
  const prof = await D.getDoc('profiles', id);

  // Tributes
  if (status === 'approved') {
    const n = { legend: 7, vvip: 5, vip: 3, regular: 2 }[category] - (idx % 2);
    const used = new Set();
    const snapshot = { slug: prof.slug, first_name: first, last_name: last, titles, category };
    for (let k = 0; k < n; k++) {
      const v = pick(visitors); if (used.has(v)) continue; used.add(v);
      const fee = D.prices(category).tributeFee; const tid = `${id}_${v}`; const u = users.get(v);
      await D.col('tributes').doc(tid).set({
        profile_id: id, user_id: v, user_name: u.full_name, relationship: pick(['Former student', 'Neighbour', 'Colleague', 'Church member', 'Nephew', 'Friend', '']),
        message: pick(TRIBUTES), amount: fee, status: 'pending_payment', paid_at: null, created_at: nowISO(), reported: false, reports: [],
        profile: snapshot, searchTokens: searchTokens(u.full_name, first, last),
      });
      await paid(v, 'tribute', tid, fee);
    }
    // Flowers (visitors may lay more than one)
    const FLW = ['lily', 'rose', 'marigold', 'chrysanthemum', 'carnation'];
    const NOTES = ['Rest well. We miss you every day.', 'Till we meet again, Mummy.', 'Thank you for everything you taught us.', '', 'Forever in our hearts.', 'Sleep well, Papa. Your grandchildren are doing well.', ''];
    const nf = { legend: 9, vvip: 6, vip: 4, regular: 2 }[category] + (idx % 3);
    for (let k = 0; k < nf; k++) {
      const v = pick(visitors); const fee = D.prices(category).flowerFee; const note = pick(NOTES); const u = users.get(v);
      const ref = D.col('flowers').doc();
      await ref.set({
        profile_id: id, user_id: v, user_name: u.full_name, flower: pick(FLW), note: note || null, amount: fee, status: 'pending_payment',
        paid_at: null, created_at: nowISO(), profile: snapshot, searchTokens: searchTokens(u.full_name, first, last),
      });
      await paid(v, 'flower', ref.id, fee);
    }
    if (rank >= 2) {
      const c = 3 + Math.floor(rnd() * 40);
      await D.col('profiles').doc(id).update({ candles: c, views: c * 7 });
    }
  }
  return id;
}

async function main() {
  await app.ready;
  if (await D.first(D.col('profiles')) && !process.argv.includes('--force')) {
    console.log('The database already has memorials. Use --force to add more demo data.');
    return;
  }
  await mkUser(config.adminEmail, 'tillwemeet Admin', 'admin', adminPw);
  const creator = await mkUser('family@example.com', 'Amaka Okonkwo');
  await D.col('users').doc(creator).update({ bank_name: 'Access Bank', account_number: '0123456789', account_name: 'Amaka Okonkwo' });
  const creators = [creator, await mkUser('tunde.family@example.com', 'Tunde Balogun'), await mkUser('halima.family@example.com', 'Halima Bello')];
  const visitors = [];
  for (let i = 0; i < 14; i++) visitors.push(await mkUser(`visitor${i + 1}@example.com`, `${pick([...F, ...M])} ${pick(S)}`));
  const tones = (await D.find(D.col('tones'))).sort((a, b) => a.sort - b.sort);
  const ctx = { creators, visitors, tones };

  let idx = 0;
  const plan = [['legend', 5], ['vvip', 10], ['vip', 14], ['regular', 34]];
  for (const [category, n] of plan) {
    for (let i = 0; i < n; i++) await makeProfile({ category, idx: idx++, featured: category === 'vvip' && i === 0 ? 1 : 0 }, ctx);
    console.log(`  ${category} done`);
  }
  await makeProfile({ category: 'vip', status: 'pending_review', idx: idx++ }, ctx);
  await makeProfile({ category: 'regular', status: 'pending_review', idx: idx++ }, ctx);
  await makeProfile({ category: 'vvip', status: 'pending_review', idx: idx++ }, ctx);
  await makeProfile({ category: 'regular', status: 'awaiting_payment', idx: idx++ }, ctx);

  // Charity partners and one disbursement
  const placeholder = await D.find(D.col('charities'));
  if (placeholder.length <= 1) {
    for (const c of placeholder) await D.col('charities').doc(c.id).delete();
    const partners = [
      ['Sample Children’s Hospital Fund', 'hospital', 'Lagos', 'Demo partner. Covers emergency surgery for children whose families cannot pay.'],
      ['Sample Hope Orphanage', 'orphanage', 'Enugu', 'Demo partner. Food, school fees and medical care for 60 children.'],
      ['Sample Sickle Cell Research Programme', 'research', 'Ibadan', 'Demo partner. Funds screening and research into sickle cell disease.'],
    ];
    const refs = [];
    for (const [name, kind, location, description] of partners) refs.push(await D.col('charities').add({ name, kind, location, description, active: true, given: 0, created_at: nowISO() }));
    const amount = Math.floor(((await D.getStats()).charity_total || 0) * 0.5);
    const batch = D.db.batch();
    batch.create(D.col('charity_disbursements').doc(), { charity_id: refs[0].id, charity_name: partners[0][0], amount, reference: 'DEMO-TRF-001', note: 'First quarterly disbursement', created_by: null, created_at: nowISO() });
    batch.update(refs[0], { given: D.inc(amount) });
    D.bumpStats(batch, { charity_given: amount });
    await batch.commit();
  }
  // A pending withdrawal
  const batch = D.db.batch();
  batch.create(D.col('withdrawals').doc(), { user_id: creator, user_name: 'Amaka Okonkwo', user_email: 'family@example.com', amount: 5000, bank_name: 'Access Bank', account_number: '0123456789', account_name: 'Amaka Okonkwo', status: 'pending', admin_note: null, created_at: nowISO(), processed_at: null });
  batch.update(D.col('users').doc(creator), { withdrawn: D.inc(5000) });
  await batch.commit();

  console.log(`Seeded ${idx} memorials.`);
  console.log(`Admin:   ${config.adminEmail} / ${adminPw}`);
  console.log('Creator: family@example.com / demo12345');
  console.log('Visitor: visitor1@example.com / demo12345');
}

main().then(() => { if (D.db.flush) D.db.flush(); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
