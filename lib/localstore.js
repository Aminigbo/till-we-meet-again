// A small Firestore-compatible store for local development and tests.
//
// It implements the part of the firebase-admin Firestore API that tillwemeet uses, and it is
// deliberately strict where Firestore is strict, so code that works here works on Firestore:
//   - transactions must do all reads before any writes, and retry on conflicting writes
//   - create() fails with ALREADY_EXISTS (code 6) if the document exists
//   - update() fails with NOT_FOUND (code 5) if the document is missing
//   - orderBy() leaves out documents that don't have the field
//   - range filters must be on one field, and that field must be the first orderBy
//   - at most one array-contains per query; "in" takes at most 30 values
// It also records the shape of every query, which scripts/gen-indexes.js turns into
// firestore.indexes.json.
//
// NOT for production. Production uses real Firestore through firebase-admin.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class FsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ---------- FieldValue ----------
class Sentinel { constructor(kind, arg) { this.kind = kind; this.arg = arg; } }
const FieldValue = {
  increment: (n) => new Sentinel('inc', n),
  arrayUnion: (...v) => new Sentinel('union', v),
  arrayRemove: (...v) => new Sentinel('remove', v),
  delete: () => new Sentinel('delete'),
  serverTimestamp: () => new Sentinel('ts'),
};

const clone = (v) => (v === undefined ? undefined : v instanceof Date ? new Date(v) : JSON.parse(JSON.stringify(v, (k, x) => x)));
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Sentinel);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkValue(v, where) {
  if (v === undefined) return; // stripped (ignoreUndefinedProperties: true)
  if (typeof v === 'number' && !Number.isFinite(v)) throw new FsError(3, `Invalid number at ${where}`);
  if (typeof v === 'function') throw new FsError(3, `Functions can't be stored (${where})`);
  if (Array.isArray(v)) v.forEach((x, i) => { if (Array.isArray(x)) throw new FsError(3, `Nested arrays aren't allowed in Firestore (${where})`); checkValue(x, `${where}[${i}]`); });
  else if (isPlain(v)) for (const [k, x] of Object.entries(v)) checkValue(x, `${where}.${k}`);
}

function stripUndefined(obj) {
  if (Array.isArray(obj)) return obj.filter((x) => x !== undefined).map(stripUndefined);
  if (isPlain(obj)) { const o = {}; for (const [k, v] of Object.entries(obj)) if (v !== undefined) o[k] = stripUndefined(v); return o; }
  return obj;
}

function applySentinels(target, data, { merge }) {
  const out = merge ? { ...(target || {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Sentinel) {
      const cur = out[k];
      if (v.kind === 'inc') out[k] = (typeof cur === 'number' ? cur : 0) + v.arg;
      else if (v.kind === 'union') out[k] = [...(Array.isArray(cur) ? cur : []), ...v.arg.filter((x) => !(Array.isArray(cur) ? cur : []).some((c) => eq(c, x)))];
      else if (v.kind === 'remove') out[k] = (Array.isArray(cur) ? cur : []).filter((c) => !v.arg.some((x) => eq(c, x)));
      else if (v.kind === 'delete') delete out[k];
      else if (v.kind === 'ts') out[k] = new Date();
    } else if (merge && isPlain(v) && isPlain(out[k])) out[k] = applySentinels(out[k], v, { merge: true });
    else out[k] = clone(v);
  }
  return out;
}

const autoId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(20); let s = '';
  for (let i = 0; i < 20; i++) s += chars[b[i] % chars.length];
  return s;
};

function validId(id) {
  if (typeof id !== 'string' || !id || id.includes('/') || id === '.' || id === '..' || /^__.*__$/.test(id) || Buffer.byteLength(id) > 1500) {
    throw new FsError(3, `Invalid document id: ${JSON.stringify(id)}`);
  }
}

// Firestore type ordering for sorting/comparison: null < bool < number < date < string < array < map
const typeRank = (v) => (v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : v instanceof Date ? 3 : typeof v === 'string' ? 4 : Array.isArray(v) ? 5 : 6);
function cmp(a, b) {
  const ra = typeRank(a); const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 3) return a.getTime() - b.getTime();
  if (ra === 5 || ra === 6) return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
const getField = (obj, fieldPath) => fieldPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ---------- Snapshots ----------
class DocumentSnapshot {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; }
  data() { return this.exists ? clone(this._d) : undefined; }
  get(field) { return this.exists ? clone(getField(this._d, field)) : undefined; }
}
class QuerySnapshot {
  constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; }
  forEach(fn) { this.docs.forEach(fn); }
}

// ---------- References ----------
class DocumentReference {
  constructor(store, collection, id) { this._s = store; this._c = collection; this.id = id; this.path = `${collection}/${id}`; }
  get parent() { return this._s.collection(this._c); }
  async get() { return this._s._snap(this); }
  async set(data, opts = {}) { this._s._write([{ op: 'set', ref: this, data, opts }]); return { writeTime: new Date() }; }
  async create(data) { this._s._write([{ op: 'create', ref: this, data }]); return { writeTime: new Date() }; }
  async update(data) { this._s._write([{ op: 'update', ref: this, data }]); return { writeTime: new Date() }; }
  async delete() { this._s._write([{ op: 'delete', ref: this }]); return { writeTime: new Date() }; }
}

const RANGE_OPS = ['<', '<=', '>', '>=', '!=', 'not-in'];
class Query {
  constructor(store, collection, spec = { filters: [], orders: [], limit: null, offset: 0 }) { this._s = store; this._c = collection; this._q = spec; }
  _with(patch) { return new Query(this._s, this._c, { ...this._q, ...patch, filters: patch.filters || this._q.filters, orders: patch.orders || this._q.orders }); }
  where(field, op, value) {
    if (value === undefined) throw new FsError(3, `where('${field}', '${op}', undefined) isn't allowed`);
    const ops = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'];
    if (!ops.includes(op)) throw new FsError(3, `Unknown operator ${op}`);
    if ((op === 'in' || op === 'not-in' || op === 'array-contains-any') && (!Array.isArray(value) || value.length === 0 || value.length > 30)) throw new FsError(3, `'${op}' needs 1–30 values`);
    return this._with({ filters: [...this._q.filters, { field, op, value }] });
  }
  orderBy(field, dir = 'asc') {
    if (!['asc', 'desc'].includes(dir)) throw new FsError(3, 'orderBy direction must be asc or desc');
    return this._with({ orders: [...this._q.orders, { field, dir }] });
  }
  limit(n) { return this._with({ limit: n }); }
  offset(n) { return this._with({ offset: n }); }
  count() { const q = this; return { get: async () => { const n = q._run(true).length; return { data: () => ({ count: n }) }; } }; }
  async get() { return new QuerySnapshot(this._run().map(([id, d]) => new DocumentSnapshot(new DocumentReference(this._s, this._c, id), d))); }

  _validate() {
    const { filters, orders } = this._q;
    const ranges = [...new Set(filters.filter((f) => RANGE_OPS.includes(f.op)).map((f) => f.field))];
    if (ranges.length > 1) throw new FsError(9, `Range filters on more than one field (${ranges.join(', ')}). Keep range filters on a single field.`);
    if (ranges.length && orders.length && orders[0].field !== ranges[0]) throw new FsError(9, `The first orderBy must be the range-filtered field '${ranges[0]}'.`);
    if (filters.filter((f) => f.op.startsWith('array-contains')).length > 1) throw new FsError(9, 'Only one array-contains filter is allowed per query.');
    const seenEq = filters.filter((f) => f.op === '==').map((f) => f.field);
    for (const o of orders) if (seenEq.includes(o.field)) throw new FsError(3, `orderBy('${o.field}') on a field with an equality filter isn't allowed.`);
  }

  _run(forCount = false) {
    this._validate();
    this._s._record(this._c, this._q, forCount);
    const { filters, orders, limit, offset } = this._q;
    let docs = [...(this._s._data[this._c] || new Map()).entries()].map(([id, e]) => [id, e.data]);
    const match = (d) => filters.every(({ field, op, value }) => {
      const v = getField(d, field);
      switch (op) {
        case '==': return v !== undefined && cmp(v, value) === 0 && typeRank(v) === typeRank(value);
        case '!=': return v !== undefined && v !== null && !(cmp(v, value) === 0 && typeRank(v) === typeRank(value));
        case '<': return v !== undefined && typeRank(v) === typeRank(value) && cmp(v, value) < 0;
        case '<=': return v !== undefined && typeRank(v) === typeRank(value) && cmp(v, value) <= 0;
        case '>': return v !== undefined && typeRank(v) === typeRank(value) && cmp(v, value) > 0;
        case '>=': return v !== undefined && typeRank(v) === typeRank(value) && cmp(v, value) >= 0;
        case 'in': return v !== undefined && value.some((x) => eq(x, v));
        case 'not-in': return v !== undefined && v !== null && !value.some((x) => eq(x, v));
        case 'array-contains': return Array.isArray(v) && v.some((x) => eq(x, value));
        case 'array-contains-any': return Array.isArray(v) && v.some((x) => value.some((y) => eq(x, y)));
        default: return false;
      }
    });
    docs = docs.filter(([, d]) => match(d));
    // Firestore leaves out documents that lack an orderBy field
    docs = docs.filter(([, d]) => orders.every((o) => getField(d, o.field) !== undefined));
    docs.sort(([ia, a], [ib, b]) => {
      for (const o of orders) { const c = cmp(getField(a, o.field), getField(b, o.field)); if (c) return o.dir === 'desc' ? -c : c; }
      const lastDir = orders.length ? orders[orders.length - 1].dir : 'asc';
      return lastDir === 'desc' ? (ia < ib ? 1 : -1) : (ia < ib ? -1 : 1);
    });
    if (forCount) return docs;
    if (offset) docs = docs.slice(offset);
    if (limit != null) docs = docs.slice(0, limit);
    return docs;
  }
}

class CollectionReference extends Query {
  constructor(store, name) { super(store, name); this.id = name; }
  doc(id) { const i = id === undefined ? autoId() : id; validId(i); return new DocumentReference(this._s, this._c, i); }
  async add(data) { const ref = this.doc(); await ref.create(data); return ref; }
}

class Transaction {
  constructor(store) { this._s = store; this._reads = new Map(); this._writes = []; }
  async get(refOrQuery) {
    if (this._writes.length) throw new FsError(3, 'Firestore transactions require all reads to be executed before all writes.');
    if (refOrQuery instanceof DocumentReference) {
      const e = this._s._entry(refOrQuery); this._reads.set(refOrQuery.path, e ? e.v : 0);
      return this._s._snap(refOrQuery);
    }
    const snap = await refOrQuery.get();
    snap.docs.forEach((d) => { const e = this._s._entry(d.ref); this._reads.set(d.ref.path, e ? e.v : 0); });
    return snap;
  }
  async getAll(...refs) { return Promise.all(refs.map((r) => this.get(r))); }
  set(ref, data, opts = {}) { this._writes.push({ op: 'set', ref, data, opts }); return this; }
  create(ref, data) { this._writes.push({ op: 'create', ref, data }); return this; }
  update(ref, data) { this._writes.push({ op: 'update', ref, data }); return this; }
  delete(ref) { this._writes.push({ op: 'delete', ref }); return this; }
}

class WriteBatch {
  constructor(store) { this._s = store; this._w = []; }
  set(ref, data, opts = {}) { this._w.push({ op: 'set', ref, data, opts }); return this; }
  create(ref, data) { this._w.push({ op: 'create', ref, data }); return this; }
  update(ref, data) { this._w.push({ op: 'update', ref, data }); return this; }
  delete(ref) { this._w.push({ op: 'delete', ref }); return this; }
  async commit() { if (this._w.length > 500) throw new FsError(3, 'A batch can hold at most 500 writes.'); this._s._write(this._w); return []; }
}

class LocalFirestore {
  constructor({ file } = {}) {
    this._file = file || null; this._data = {}; this._version = 0; this.queryShapes = new Map(); this._timer = null;
    if (this._file && fs.existsSync(this._file)) {
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      for (const [c, docs] of Object.entries(raw)) this._data[c] = new Map(Object.entries(docs).map(([id, d]) => [id, { data: d, v: 1 }]));
    }
    if (this._file) process.on('exit', () => this.flush());
  }
  collection(name) { if (!name || name.includes('/')) throw new FsError(3, 'Invalid collection name'); return new CollectionReference(this, name); }
  batch() { return new WriteBatch(this); }
  async getAll(...refs) { return refs.map((r) => this._snap(r)); }
  // Firestore's server SDK locks documents a transaction reads, so contending transactions queue up rather than fail.
  // Here, conflicting transactions retry with a random back-off, which gives the same outcome.
  async runTransaction(fn, { maxAttempts = 30 } = {}) {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, Math.random() * Math.min(100, 4 * attempt)));
      const tx = new Transaction(this);
      const result = await fn(tx);
      const conflict = [...tx._reads.entries()].some(([p, v]) => { const [c, id] = p.split('/'); const e = this._data[c] && this._data[c].get(id); return (e ? e.v : 0) !== v; });
      if (!conflict) { this._write(tx._writes); return result; }
      if (attempt >= maxAttempts) throw new FsError(10, 'Transaction aborted after too many conflicting writes.');
    }
  }
  settings() {}
  terminate() { this.flush(); }

  _entry(ref) { return this._data[ref._c] && this._data[ref._c].get(ref.id); }
  _snap(ref) { const e = this._entry(ref); return new DocumentSnapshot(ref, e ? e.data : undefined); }
  _write(ops) {
    // Validate everything first so the write is all-or-nothing
    const staged = new Map();
    const current = (ref) => (staged.has(ref.path) ? staged.get(ref.path) : (this._entry(ref) || {}).data);
    for (const w of ops) {
      const { op, ref } = w;
      if (op !== 'delete') {
        if (!isPlain(w.data)) throw new FsError(3, `Document data must be an object (${ref.path})`);
        checkValue(w.data, ref.path);
      }
      const cur = current(ref);
      if (op === 'create' && cur !== undefined) throw new FsError(6, `ALREADY_EXISTS: ${ref.path}`);
      if (op === 'update' && cur === undefined) throw new FsError(5, `NOT_FOUND: no document to update: ${ref.path}`);
      if (op === 'delete') staged.set(ref.path, undefined);
      else staged.set(ref.path, applySentinels(cur, stripUndefined(w.data), { merge: op === 'update' || (op === 'set' && w.opts && w.opts.merge) }));
    }
    for (const [p, d] of staged) {
      const [c, id] = p.split('/');
      this._data[c] = this._data[c] || new Map();
      if (d === undefined) this._data[c].delete(id);
      else { const e = this._data[c].get(id); this._data[c].set(id, { data: d, v: (e ? e.v : 0) + 1 }); }
    }
    this._schedulePersist();
  }
  _record(collection, q, forCount) {
    const shape = { collection, filters: q.filters.map((f) => ({ field: f.field, op: f.op })), orders: q.orders.map((o) => ({ field: o.field, dir: o.dir })) };
    const key = JSON.stringify(shape);
    if (!this.queryShapes.has(key)) this.queryShapes.set(key, { ...shape, count: forCount });
  }
  _schedulePersist() {
    if (!this._file || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 250);
    this._timer.unref();
  }
  flush() {
    if (!this._file) return;
    const out = {};
    for (const [c, m] of Object.entries(this._data)) out[c] = Object.fromEntries([...m.entries()].map(([id, e]) => [id, e.data]));
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    fs.writeFileSync(this._file + '.tmp', JSON.stringify(out));
    fs.renameSync(this._file + '.tmp', this._file);
  }
}

/**
 * Turns recorded query shapes into Firestore composite index definitions.
 * Single-field indexes (created automatically by Firestore) cover queries on one field and
 * equality-only queries; everything else needs a composite index.
 */
function compositeIndexes(shapes) {
  const out = new Map();
  for (const s of shapes) {
    const fields = new Set([...s.filters.map((f) => f.field), ...s.orders.map((o) => o.field)]);
    const hasRange = s.filters.some((f) => RANGE_OPS.includes(f.op));
    const equalityOnly = s.orders.length === 0 && !hasRange;
    if (fields.size < 2 || equalityOnly) continue;
    const orderFields = s.orders.map((o) => o.field);
    const def = [];
    for (const f of s.filters) {
      if (orderFields.includes(f.field) || def.some((d) => d.fieldPath === f.field)) continue;
      if (f.op.startsWith('array-contains')) def.push({ fieldPath: f.field, arrayConfig: 'CONTAINS' });
      else if (!RANGE_OPS.includes(f.op)) def.push({ fieldPath: f.field, order: 'ASCENDING' });
    }
    for (const f of s.filters) if (RANGE_OPS.includes(f.op) && !orderFields.includes(f.field) && !def.some((d) => d.fieldPath === f.field)) def.push({ fieldPath: f.field, order: 'ASCENDING' });
    for (const o of s.orders) def.push({ fieldPath: o.field, order: o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING' });
    const idx = { collectionGroup: s.collection, queryScope: 'COLLECTION', fields: def };
    out.set(JSON.stringify(idx), idx);
  }
  return [...out.values()].sort((a, b) => (a.collectionGroup + JSON.stringify(a.fields)).localeCompare(b.collectionGroup + JSON.stringify(b.fields)));
}

module.exports = { LocalFirestore, FieldValue, FsError, compositeIndexes };
