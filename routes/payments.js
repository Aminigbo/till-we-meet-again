const config = require('../lib/config');
const D = require('../lib/db');
const pay = require('../lib/payments');
const { HttpError } = require('../lib/app');
const { html, naira } = require('../lib/util');
const { layout, csrf } = require('../views/layout');
const { requireAuth } = require('./auth');

const PURPOSE = { listing: 'Memorial listing fee', tribute: 'Tribute', flower: 'Flower', upgrade: 'Category upgrade' };
const THANKS = { tribute: 'Thank you. Your tribute is now on the memorial.', flower: 'Your flower has been laid. Download your card below.', listing: 'Payment received. Our team will review the memorial shortly.', upgrade: 'Payment received. The upgrade is active, and you can edit the memorial to add the new features.' };

function register(app) {
  app.csrfExempt.add('/payments/webhook');

  // Paystack redirects here after checkout
  app.get('/payments/callback', requireAuth, async (req, res) => {
    const ref = String(req.query.reference || req.query.trxref || '');
    const p = await pay.confirm(ref);
    if (p.user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(404, 'Payment not found');
    if (p.status === 'success') req.flash('ok', THANKS[p.purpose]);
    else req.flash('error', 'The payment didn’t go through. You have not been charged. Try again.');
    res.redirect(pay.returnPath(p));
  });

  // Paystack server-to-server notification
  app.post('/payments/webhook', async (req, res) => {
    if (!pay.validWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) { res.writeHead(401); return res.end(); }
    const evt = req.body;
    if (evt.event === 'charge.success' && evt.data?.reference) {
      try { await pay.confirm(evt.data.reference); } catch (e) { console.error('webhook', e.message); }
    }
    res.writeHead(200); res.end('ok');
  });

  // Simulated checkout, used only when no Paystack key is configured
  const ownPayment = async (req) => {
    const p = await D.getDoc('payments', req.params.ref);
    if (!p || p.user_id !== req.user.id) throw new HttpError(404, 'Payment not found');
    return p;
  };

  app.get('/payments/simulate/:ref', requireAuth, async (req, res) => {
    if (config.paymentsLive) throw new HttpError(404, 'Not found');
    const p = await ownPayment(req);
    res.html(layout(req, {
      title: 'Checkout',
      body: html`<section class="narrow">
        <div class="card checkout">
          <p class="checkout__label">${PURPOSE[p.purpose]}</p>
          <p class="checkout__amount">${naira(p.amount)}</p>
          <p class="muted">Reference ${p.reference}</p>
          <p class="notice">This is a simulated checkout because no Paystack key is set. With a key, visitors pay by card, bank transfer or USSD on Paystack.</p>
          ${p.status === 'pending' ? html`<form method="post" action="/payments/simulate/${p.reference}">${csrf(req)}
            <button class="btn btn--brass btn--block" name="outcome" value="success">Pay ${naira(p.amount)}</button>
            <button class="btn btn--ghost btn--block" name="outcome" value="fail">Cancel payment</button></form>`
          : html`<p>This payment is ${p.status}.</p><a class="btn btn--ink" href="${pay.returnPath(p)}">Continue</a>`}
        </div></section>`,
    }));
  });

  app.post('/payments/simulate/:ref', requireAuth, async (req, res) => {
    if (config.paymentsLive) throw new HttpError(404, 'Not found');
    const p = await ownPayment(req);
    if (req.body.outcome === 'success') {
      await pay.confirm(p.reference);
      req.flash('ok', THANKS[p.purpose]);
    } else {
      await pay.markFailed(p.reference);
      req.flash('info', 'Payment cancelled. Nothing was charged.');
    }
    res.redirect(pay.returnPath(await D.getDoc('payments', p.reference)));
  });
}

module.exports = { register };
