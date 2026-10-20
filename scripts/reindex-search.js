// Rebuilds the search fields (name prefixes, location and year keys) on every memorial.
// Run once after upgrading to a version with new search features: npm run reindex
const D = require('../lib/db');
const P = require('../lib/profiles');

(async () => {
  let done = 0;
  for (;;) {
    const rows = await D.find(D.col('profiles').orderBy('created_at', 'asc').offset(done).limit(300));
    if (!rows.length) break;
    const batch = D.db.batch();
    for (const p of rows) batch.update(D.col('profiles').doc(p.id), P.derived(p));
    await batch.commit();
    done += rows.length;
    console.log(`  ${done} memorials updated`);
  }
  if (D.db.flush) D.db.flush();
  console.log(`Search fields rebuilt on ${done} memorials.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
