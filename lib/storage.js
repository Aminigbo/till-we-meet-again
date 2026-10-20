// File storage for uploads: Firebase Cloud Storage when FIREBASE_STORAGE_BUCKET is set,
// otherwise the local data/uploads folder. Files are always served through the app, so private
// documents (death certificates, NIN photos) never get a public URL.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { bucket } = require('./firestore');

const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4',
  mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg',
};
const contentType = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
const clean = (name) => path.basename(String(name || ''));
const localPath = (vis, name) => path.join(config.dataDir, 'uploads', vis, clean(name));

if (!bucket) {
  fs.mkdirSync(path.join(config.dataDir, 'uploads', 'public'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'uploads', 'private'), { recursive: true });
}

async function put(vis, name, data) {
  if (bucket) {
    await bucket.file(`${vis}/${clean(name)}`).save(data, {
      resumable: false, contentType: contentType(name),
      metadata: { cacheControl: vis === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store' },
    });
  } else fs.writeFileSync(localPath(vis, name), data);
}

async function read(vis, name) {
  if (!name) return null;
  try {
    if (bucket) return (await bucket.file(`${vis}/${clean(name)}`).download())[0];
    return fs.readFileSync(localPath(vis, name));
  } catch { return null; }
}

async function remove(vis, name) {
  if (!name) return;
  try {
    if (bucket) await bucket.file(`${vis}/${clean(name)}`).delete({ ignoreNotFound: true });
    else fs.unlinkSync(localPath(vis, name));
  } catch { /* already gone */ }
}

/** Streams a stored file to the response, with HTTP range support for audio and video. */
async function serve(req, res, vis, name, maxAge) {
  name = clean(name);
  let size; let open;
  if (bucket) {
    const file = bucket.file(`${vis}/${name}`);
    try { size = Number((await file.getMetadata())[0].size); } catch { return false; }
    open = (o) => file.createReadStream(o ? { start: o.start, end: o.end } : {});
  } else {
    const p = localPath(vis, name);
    try { const st = fs.statSync(p); if (!st.isFile()) return false; size = st.size; } catch { return false; }
    open = (o) => fs.createReadStream(p, o || {});
  }
  const headers = { 'Content-Type': contentType(name), 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'private, no-store', 'Accept-Ranges': 'bytes' };
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    open({ start, end }).on('error', () => res.destroy()).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  open().on('error', () => res.destroy()).pipe(res);
  return true;
}

module.exports = { put, read, remove, serve, usingCloud: !!bucket };
