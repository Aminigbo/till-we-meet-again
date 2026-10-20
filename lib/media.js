const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const storage = require('./storage');
const { sniff, token } = require('./util');
const { HttpError } = require('./app');

/**
 * Validate an uploaded file by its content (never the browser's claim) and store it.
 * kinds: 'image' | 'pdf' | 'video' | 'audio'; visibility: 'public' | 'private'. Returns the stored name.
 */
async function saveUpload(file, { kinds, maxMB, visibility, label }) {
  if (!file) return null;
  const t = sniff(file.data);
  if (!t || !kinds.includes(t.kind)) {
    throw new HttpError(400, `${label}: this file type isn't accepted. Use ${kinds.map((k) => ({ image: 'JPG, PNG or WebP', pdf: 'PDF', video: 'MP4, MOV or WebM', audio: 'MP3 or OGG' }[k])).join(' or ')}.`);
  }
  if (file.size > maxMB * 1048576) throw new HttpError(400, `${label}: the file is larger than ${maxMB}MB.`);
  const name = `${token(12)}.${t.ext}`;
  await storage.put(visibility, name, file.data);
  return name;
}

const removeUpload = (name, visibility) => storage.remove(visibility, name);

/** Video length in seconds using ffprobe. Returns null if ffprobe isn't installed, NaN if unreadable. */
function videoDuration(data) {
  const tmp = path.join(os.tmpdir(), `twm-${token(6)}`);
  fs.writeFileSync(tmp, data);
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', tmp], { timeout: 20000 }, (err, out) => {
      fs.rm(tmp, () => {});
      if (err) return resolve(err.code === 'ENOENT' ? null : NaN);
      const d = parseFloat(out); resolve(Number.isFinite(d) ? d : NaN);
    });
  });
}

module.exports = { saveUpload, removeUpload, videoDuration };
