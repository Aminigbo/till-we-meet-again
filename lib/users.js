const D = require('./db');
const { hashPassword, nowISO, searchTokens } = require('./util');

class EmailTaken extends Error {}

/** Creates a user. The email is claimed with a document in "user_emails", so it stays unique. */
async function createUser({ email, password, full_name, phone, role = 'user' }) {
  const e = String(email).toLowerCase();
  const emailRef = D.col('user_emails').doc(e);
  const userRef = D.col('users').doc();
  await D.db.runTransaction(async (tx) => {
    if ((await tx.get(emailRef)).exists) throw new EmailTaken('email taken');
    tx.create(emailRef, { uid: userRef.id });
    tx.create(userRef, {
      email: e, password_hash: hashPassword(password), full_name, phone: phone || '', role, status: 'active',
      bank_name: null, account_number: null, account_name: null,
      earned: 0, withdrawn: 0, paid_out: 0, memorial_count: 0, tribute_count: 0,
      searchTokens: searchTokens(full_name, e, phone), created_at: nowISO(), last_login_at: null,
    });
  });
  return userRef.id;
}

async function findByEmail(email) {
  const m = await D.getDoc('user_emails', String(email || '').toLowerCase());
  return m ? D.getDoc('users', m.uid) : null;
}

module.exports = { createUser, findByEmail, EmailTaken };
