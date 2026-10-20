// Create an admin, or promote an existing user.
// Usage: npm run make-admin -- someone@example.com "a-strong-password"
const D = require('../lib/db');
const { hashPassword } = require('../lib/util');
const { createUser, findByEmail } = require('../lib/users');

(async () => {
  const [email, password] = process.argv.slice(2);
  if (!email) { console.log('Usage: npm run make-admin -- email [password]'); process.exit(1); }
  const u = await findByEmail(email);
  if (u) {
    await D.col('users').doc(u.id).update({ role: 'admin', ...(password ? { password_hash: hashPassword(password) } : {}) });
    console.log(`${email} is now an admin.`);
  } else {
    if (!password || password.length < 8) { console.log('New admins need a password of at least 8 characters.'); process.exit(1); }
    await createUser({ email, password, full_name: 'Administrator', role: 'admin' });
    console.log(`Admin ${email} created.`);
  }
  if (D.db.flush) D.db.flush();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
