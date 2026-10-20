// Checks that the local development store enforces the same rules as Firestore,
// so code that passes the smoke test behaves the same on the real database.
const assert = require('node:assert/strict');
const { LocalFirestore, FieldValue } = require('../lib/localstore');

(async () => {
  const db = new LocalFirestore();
  const ok = (m) => console.log(`  ✓ ${m}`);
  console.log('local Firestore-compatible store');

  await db.collection('a').doc('x').create({ n: 1 });
  await assert.rejects(db.collection('a').doc('x').create({ n: 2 }), (e) => e.code === 6); ok('create() fails if the document exists (ALREADY_EXISTS)');
  await assert.rejects(db.collection('a').doc('missing').update({ n: 2 }), (e) => e.code === 5); ok('update() fails if the document is missing (NOT_FOUND)');

  await assert.rejects(db.runTransaction(async (tx) => { tx.update(db.collection('a').doc('x'), { n: 3 }); await tx.get(db.collection('a').doc('x')); }), /reads to be executed before all writes/);
  ok('transactions must read before they write');

  // Conflicting transactions retry and both increments land
  const ref = db.collection('c').doc('count');
  await ref.set({ n: 0 });
  await Promise.all(Array.from({ length: 10 }, () => db.runTransaction(async (tx) => {
    const s = await tx.get(ref); await new Promise((r) => setTimeout(r, Math.random() * 5)); tx.update(ref, { n: s.data().n + 1 });
  })));
  assert.equal((await ref.get()).data().n, 10); ok('conflicting transactions retry instead of losing writes');

  await db.collection('o').doc('1').set({ a: 1, b: 5 });
  await db.collection('o').doc('2').set({ a: 2 });
  assert.equal((await db.collection('o').orderBy('b').get()).size, 1); ok('orderBy leaves out documents without the field');
  await assert.rejects(db.collection('o').where('a', '>', 0).where('b', '<', 9).get(), /more than one field/);
  await assert.rejects(db.collection('o').where('a', '>', 0).orderBy('b').get(), /first orderBy/);
  ok('range filters follow Firestore’s rules');
  assert.throws(() => db.collection('o').where('a', '==', undefined), /undefined/); ok('undefined filter values are refused');
  await assert.rejects(db.collection('o').doc('3').set({ nested: [[1]] }), /Nested arrays/); ok('nested arrays are refused');

  await db.collection('o').doc('1').update({ a: FieldValue.increment(4), tags: FieldValue.arrayUnion('x', 'y') });
  await db.collection('o').doc('1').update({ tags: FieldValue.arrayUnion('x') });
  assert.deepEqual((await db.collection('o').doc('1').get()).data(), { a: 5, b: 5, tags: ['x', 'y'] }); ok('increment and arrayUnion work like Firestore');
  assert.equal((await db.collection('o').where('a', 'in', [2, 5]).count().get()).data().count, 2); ok('count() aggregation');
  console.log('All checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
