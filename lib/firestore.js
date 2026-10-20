// Connects to Firebase. Three modes:
//   firebase  — real Firestore via firebase-admin (service account, or default credentials on Google Cloud)
//   emulator  — the Firebase emulator, when FIRESTORE_EMULATOR_HOST is set
//   local     — a Firestore-compatible file store for development without a Firebase project
//               (refused when NODE_ENV=production)
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

function readServiceAccount(v) {
  if (!v) return null;
  const s = v.trim();
  if (s.startsWith('{')) return JSON.parse(s);
  if (fs.existsSync(s)) return JSON.parse(fs.readFileSync(s, 'utf8'));
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { /* not base64 */ }
  throw new Error('FIREBASE_SERVICE_ACCOUNT must be the path to the JSON key file, the JSON itself, or the JSON in base64.');
}

let db; let FieldValue; let bucket = null; let mode;

const wantsFirebase = !!(process.env.FIRESTORE_EMULATOR_HOST || config.firebase.serviceAccount || config.firebase.projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS);

if (wantsFirebase && process.env.TWM_FORCE_LOCAL !== '1') {
  let admin;
  try {
    admin = { app: require('firebase-admin/app'), firestore: require('firebase-admin/firestore') };
  } catch {
    console.error('firebase-admin is not installed. Run "npm install" first.');
    process.exit(1);
  }
  const sa = readServiceAccount(config.firebase.serviceAccount);
  const projectId = config.firebase.projectId || (sa && sa.project_id) || process.env.GCLOUD_PROJECT;
  const opts = { projectId };
  if (config.firebase.storageBucket) opts.storageBucket = config.firebase.storageBucket;
  if (sa) opts.credential = admin.app.cert(sa);
  else if (!process.env.FIRESTORE_EMULATOR_HOST) opts.credential = admin.app.applicationDefault();
  const app = admin.app.getApps()[0] || admin.app.initializeApp(opts);
  db = admin.firestore.getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  FieldValue = admin.firestore.FieldValue;
  mode = process.env.FIRESTORE_EMULATOR_HOST ? 'emulator' : 'firebase';
  if (config.firebase.storageBucket) bucket = require('firebase-admin/storage').getStorage(app).bucket(config.firebase.storageBucket);
} else {
  if (config.isProd) {
    console.error('Set FIREBASE_SERVICE_ACCOUNT (or GOOGLE_APPLICATION_CREDENTIALS) and FIREBASE_PROJECT_ID before running in production.');
    process.exit(1);
  }
  const { LocalFirestore, FieldValue: FV } = require('./localstore');
  const file = process.env.TWM_LOCAL_MEMORY === '1' ? null : path.join(config.dataDir, 'local-firestore.json');
  db = new LocalFirestore({ file });
  FieldValue = FV;
  mode = 'local';
}

/** True when a create() failed because the document already exists. */
const isAlreadyExists = (err) => !!err && (err.code === 6 || err.code === 'already-exists' || /ALREADY_EXISTS/i.test(err.message || ''));

module.exports = { db, FieldValue, bucket, mode, isAlreadyExists };
