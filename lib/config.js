// Loads .env (no dependency) and exposes platform configuration.
const fs = require('node:fs');
const path = require('node:path');

// On Vercel the bundled file's directory is not the project root. The platform
// sets cwd to the deployment root, which is where public/ and included files live.
const ROOT = process.env.VERCEL ? process.cwd() : path.join(__dirname, '..');

// Environment files, loaded in this order (the first value found wins):
//   1. real environment variables (set by your host, e.g. Cloud Run)
//   2. .env.<NODE_ENV>   e.g. .env.production on the live server, .env.development on your computer
//   3. .env              shared defaults
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // strip trailing comments on unquoted values
    out[m[1]] = v;
  }
  return out;
}
const baseEnv = parseEnvFile(path.join(ROOT, '.env'));
const mode = process.env.NODE_ENV || baseEnv.NODE_ENV || 'development';
const modeEnv = parseEnvFile(path.join(ROOT, `.env.${mode}`));
for (const [k, v] of Object.entries({ ...baseEnv, ...modeEnv })) if (process.env[k] === undefined) process.env[k] = v;
if (process.env.NODE_ENV === undefined) process.env.NODE_ENV = mode;

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const config = {
  ROOT,
  appName: 'tillwemeet',
  port: Number(env('PORT', 3000)),
  baseUrl: env('BASE_URL', vercelHost ? `https://${vercelHost}` : 'http://localhost:3000').replace(/\/$/, ''),
  isProd: env('NODE_ENV', 'development') === 'production',
  // Vercel's deployment directory is read-only. A relative DATA_DIR such as "data"
  // cannot be created there, so the temporary store and uploads go under /tmp.
  dataDir: process.env.VERCEL
    ? ((process.env.DATA_DIR || '').startsWith('/tmp') ? process.env.DATA_DIR : '/tmp/tillwemeet')
    : path.resolve(ROOT, env('DATA_DIR', 'data')),
  sessionSecret: env('SESSION_SECRET', 'dev-only-change-me-dev-only-change-me'),
  // 32-byte key (hex) used to encrypt NIN numbers at rest
  encryptionKey: env('ENCRYPTION_KEY', ''),
  paystackSecret: env('PAYSTACK_SECRET_KEY', ''),
  paystackPublic: env('PAYSTACK_PUBLIC_KEY', ''),
  // When no Paystack key is set, a built-in simulated checkout is used (dev/demo only)
  get paymentsLive() { return !!this.paystackSecret; },
  // Firebase. FIREBASE_SERVICE_ACCOUNT is the path to the service-account JSON key (or the JSON itself).
  // Without any of these, a local Firestore-compatible file store is used (development only).
  firebase: {
    projectId: env('FIREBASE_PROJECT_ID', ''),
    serviceAccount: env('FIREBASE_SERVICE_ACCOUNT', ''),
    storageBucket: env('FIREBASE_STORAGE_BUCKET', ''),
  },
  adminEmail: env('ADMIN_EMAIL', 'admin@tillwemeet.com'),
  adminPassword: env('ADMIN_PASSWORD', ''),
  editCooldownDays: 90,
  maxUploadMB: 60,
};

// Category rules. Prices in Naira. Settings table can override prices at runtime.
config.categories = {
  regular: { key: 'regular', name: 'Regular', listingFee: 10000, tributeFee: 1000, flowerFee: 2000, tributeWords: 250, gallery: 0, tone: false, video: false, rank: 1 },
  vip:     { key: 'vip',     name: 'VIP',     listingFee: 50000, tributeFee: 5000, flowerFee: 10000, tributeWords: 500, gallery: 6, tone: true, video: false, rank: 2 },
  vvip:    { key: 'vvip',    name: 'VVIP',    listingFee: 200000, tributeFee: 20000, flowerFee: 50000, tributeWords: 1500, gallery: 12, tone: true, video: true, rank: 3 },
  legend:  { key: 'legend',  name: 'Legends', listingFee: null, tributeFee: 20000, flowerFee: 50000, tributeWords: 1500, gallery: 12, tone: true, video: true, rank: 4 },
};
config.categoryOrder = ['legend', 'vvip', 'vip', 'regular'];
config.selectableCategories = ['regular', 'vip', 'vvip'];

// Tribute and flower revenue split (must sum to 100)
config.split = { creator: 40, charity: 40, platform: 20 };

config.homePerCategory = 30;
config.flowerNoteWords = 160;
config.videoMinSec = 15;
config.videoMaxSec = 30;

module.exports = config;
