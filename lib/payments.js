// Payments via Paystack (NGN). Without a PAYSTACK_SECRET_KEY, a simulated checkout is used for demos.
// Every successful payment is applied in one Firestore transaction: the payment, the tribute/flower/memorial,
// the 40/40/20 ledger entries, the creator's wallet and the platform totals all change together or not at all.
const crypto = require('node:crypto');
const config = require('./config');
const D = require('./db');
const { token, nowISO } = require('./util');
const { HttpError } = require('./app');

const PAYSTACK = 'https://api.paystack.co';

async function paystack(method, pathname, body) {
  const r = await fetch(PAYSTACK + pathname, {
    method,
    headers: { Authorization: `Bearer ${config.paystackSecret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.status === false) throw new HttpError(502, `Payment provider error: ${json.message || r.status}`);
  return json.data;
}

/**
 * Create a pending payment and return the URL the payer should be sent to.
 * successPath / cancelPath: where the payer lands afterwards.
 */
async function startPayment({ user, purpose, targetId, amount, meta, successPath, cancelPath }) {
  if (!(amount > 0)) throw new HttpError(400, 'Invalid amount');
  const reference = `TWM-${purpose.slice(0, 3)}-${Date.now().toString(36)}-${token(4)}`.toUpperCase();
  await D.col('payments').doc(reference).create({
    reference, user_id: user.id, user_name: user.full_name, user_email: user.email, purpose, target_id: targetId,
    meta: meta || null, amount, status: 'pending', provider: config.paymentsLive ? 'paystack' : 'simulated',
    provider_response: null, success_path: successPath, cancel_path: cancelPath || successPath,
    created_at: nowISO(), verified_at: null,
  });
  if (!config.paymentsLive) return `/payments/simulate/${reference}`;
  const data = await paystack('POST', '/transaction/initialize', {
    email: user.email,
    amount: Math.round(amount * 100), // kobo
    currency: 'NGN',
    reference,
    callback_url: `${config.baseUrl}/payments/callback`,
    metadata: { purpose, target_id: targetId, user_id: user.id },
  });
  return data.authorization_url;
}

/** Confirm with the provider that a payment succeeded. */
async function verifyWithProvider(payment) {
  if (payment.provider === 'simulated') return true;
  const data = await paystack('GET', `/transaction/verify/${encodeURIComponent(payment.reference)}`);
  await D.col('payments').doc(payment.reference).update({ provider_response: { status: data.status, amount: data.amount, channel: data.channel || null, paid_at: data.paid_at || null } });
  return data.status === 'success' && data.currency === 'NGN' && Number(data.amount) === Math.round(payment.amount * 100);
}

const share = (amount, pct) => Math.round(amount * pct) / 100;

/** Apply the effects of a successful payment. Safe to call more than once. */
async function fulfil(reference) {
  const payRef = D.col('payments').doc(reference);
  const result = await D.db.runTransaction(async (tx) => {
    // ---- reads ----
    const p = D.fromSnap(await tx.get(payRef));
    if (!p || p.status === 'success') return p;
    let targetRef = null; let target = null;
    if (p.purpose === 'tribute' || p.purpose === 'flower') {
      targetRef = D.col(p.purpose === 'tribute' ? 'tributes' : 'flowers').doc(p.target_id);
      target = D.fromSnap(await tx.get(targetRef));
    }
    const profileId = target ? target.profile_id : p.target_id;
    const profRef = D.col('profiles').doc(profileId);
    const prof = D.fromSnap(await tx.get(profRef));

    // ---- writes ----
    const now = nowISO();
    tx.update(payRef, { status: 'success', verified_at: now });
    tx.set(D.col('stats_daily').doc(now.slice(0, 10)), { date: now.slice(0, 10), amount: D.inc(p.amount) }, { merge: true });
    const stats = { gross: p.amount };
    const memorial = prof ? { memorial_name: `${prof.first_name} ${prof.last_name}`, memorial_slug: prof.slug } : { memorial_name: null, memorial_slug: null };
    const ledger = (account, amount, note, extra = {}) => tx.create(D.col('ledger').doc(), {
      payment_ref: p.reference, profile_id: profileId, tribute_id: null, flower_id: null, account, user_id: null, amount, note, created_at: now, ...memorial, ...extra,
    });

    if (p.purpose === 'listing' && prof) {
      tx.update(profRef, { status: prof.status === 'awaiting_payment' ? 'pending_review' : prof.status, listing_amount: p.amount, listing_paid_at: now, updated_at: now });
      ledger('platform', p.amount, 'Memorial listing fee');
      Object.assign(stats, { listings_amount: p.amount, platform_total: p.amount });
    } else if (p.purpose === 'upgrade' && prof) {
      // Upgrading also opens one edit, so the new tone, video and gallery can be added straight away.
      if (prof.category !== 'legend') tx.update(profRef, { category: p.meta.to, last_edit_at: null, updated_at: now });
      ledger('platform', p.amount, `Upgrade to ${p.meta.to}`);
      Object.assign(stats, { listings_amount: p.amount, platform_total: p.amount });
    } else if ((p.purpose === 'tribute' || p.purpose === 'flower') && target && prof && target.status === 'pending_payment') {
      const isTribute = p.purpose === 'tribute';
      const toCreator = share(p.amount, config.split.creator);
      const toCharity = share(p.amount, config.split.charity);
      const toPlatform = share(p.amount, config.split.platform);
      tx.update(targetRef, { status: 'published', paid_at: now });
      tx.update(profRef, { [isTribute ? 'tribute_count' : 'flower_count']: D.inc(1), charity_raised: D.inc(toCharity), creator_earned: D.inc(toCreator) });
      tx.update(D.col('users').doc(prof.creator_id), { earned: D.inc(toCreator) });
      const link = isTribute ? { tribute_id: target.id } : { flower_id: target.id };
      const label = isTribute ? 'Tribute' : 'Flower';
      ledger('creator', toCreator, `${label} share`, { ...link, user_id: prof.creator_id });
      ledger('charity', toCharity, `${label} charity share`, link);
      ledger('platform', toPlatform, `${label} platform share`, link);
      Object.assign(stats, {
        [isTribute ? 'tributes_amount' : 'flowers_amount']: p.amount, [isTribute ? 'tributes_count' : 'flowers_count']: 1,
        creator_total: toCreator, charity_total: toCharity, platform_total: toPlatform,
      });
    }
    D.bumpStats(tx, stats);
    return { ...p, status: 'success', verified_at: now };
  });
  D.bustCache();
  return result;
}

async function confirm(reference) {
  const p = await D.getDoc('payments', reference);
  if (!p) throw new HttpError(404, 'Payment not found');
  if (p.status === 'success') return p;
  const ok = await verifyWithProvider(p);
  if (!ok) { await markFailed(reference); return { ...p, status: 'failed' }; }
  return fulfil(reference);
}

async function markFailed(reference) {
  const ref = D.col('payments').doc(reference);
  await D.db.runTransaction(async (tx) => {
    const p = D.fromSnap(await tx.get(ref));
    if (p && p.status === 'pending') tx.update(ref, { status: 'failed' });
  });
}

function validWebhookSignature(rawBody, signature) {
  if (!config.paystackSecret || !signature) return false;
  const expected = crypto.createHmac('sha512', config.paystackSecret).update(rawBody).digest('hex');
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Where a payer lands after payment */
const returnPath = (p) => (p.status === 'success' ? p.success_path : p.cancel_path) || '/';

/** A creator's earnings: earned (40% shares), withdrawn (requested, pending or paid) and paid out. */
function walletOf(u) {
  const earned = u.earned || 0; const withdrawn = u.withdrawn || 0; const paidOut = u.paid_out || 0;
  return { earned, available: Math.round((earned - withdrawn) * 100) / 100, paidOut, pending: Math.round((withdrawn - paidOut) * 100) / 100 };
}
async function walletBalance(userId) { return walletOf((await D.getDoc('users', userId)) || {}); }

module.exports = { startPayment, confirm, fulfil, markFailed, validWebhookSignature, returnPath, walletBalance, walletOf };
