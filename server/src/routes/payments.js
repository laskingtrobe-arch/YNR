'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { wrap, bad, notFound, conflict, rateLimit, HttpError } = require('../middleware');
const { id, formatNaira } = require('../lib/util');
const paystack = require('../services/paystack');
const { markOrderProductsSold, notifyOwner, sendMail } = require('../services');

const router = express.Router();

// Postgres's unique-violation error code. Used to tell "this exact webhook
// event was already recorded" (expected, safe to ignore) apart from any
// other database failure (must not be silently swallowed).
const PG_UNIQUE_VIOLATION = '23505';

// ---------------------------------------------------------------------------
// Fulfilment
//
// Single place where an order becomes paid. Idempotent: replaying a webhook,
// or a callback racing the webhook, must not double-fulfil or double-notify.
// The paid-status flip and the products-sold update happen on one connection
// inside db.transaction(), so a crash partway through cannot leave an order
// marked paid with its piece still showing as available, or vice versa.
// ---------------------------------------------------------------------------
async function fulfil(order, amountKobo, reference) {
  if (order.payment_status === 'paid') {
    return { alreadyPaid: true };
  }

  const outcome = await db.transaction(async (tx) => {
    const fresh = await tx.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    if (fresh.payment_status === 'paid') return { alreadyPaid: true };

    await tx.run(
      `UPDATE orders
          SET payment_status = 'paid', status = 'paid', paid_at = ?,
              amount_paid_kobo = ?, paystack_reference = ?, updated_at = ?
        WHERE id = ?`,
      [db.now(), amountKobo, reference, db.now(), order.id]
    );
    await markOrderProductsSold(tx, order.id);
    return { alreadyPaid: false };
  });

  if (outcome.alreadyPaid) return outcome;

  await notifyOwner(
    `PAID ${order.reference} — ${formatNaira(amountKobo)}`,
    `${order.customer_name} (${order.customer_phone}) has paid for order ${order.reference}.`
  );
  await sendMail(
    order.customer_email,
    `Payment received — ${order.reference}`,
    `Hi ${order.customer_name},\n\nWe have received ${formatNaira(amountKobo)} for order ` +
    `${order.reference}. Your piece is now reserved for you and we will be in touch ` +
    `about delivery.\n\n— YnR`
  );
  return outcome;
}

// ---------------------------------------------------------------------------
// Start a payment
// ---------------------------------------------------------------------------
router.post('/payments/init',
  rateLimit({ key: 'pay-init', windowMs: 10 * 60_000, max: 15 }),
  wrap(async (req, res) => {
    if (!paystack.enabled()) {
      throw new HttpError(503,
        'Card payment is not switched on yet. Please check out on WhatsApp.',
        'paystack_unconfigured');
    }

    const reference = String((req.body && req.body.reference) || '').toUpperCase();
    const order = await db.get('SELECT * FROM orders WHERE reference = ?', [reference]);
    if (!order) throw notFound('No order with that reference.');

    if (order.payment_status === 'paid') throw conflict('That order is already paid.', 'already_paid');
    if (order.status === 'cancelled') throw conflict('That order was cancelled.', 'cancelled');
    if (order.total_kobo <= 0) throw bad('That order has no payable total yet.', 'no_total');

    // Amount comes from the database, never from the browser.
    const data = await paystack.initialize({
      email: order.customer_email,
      amountKobo: order.total_kobo,
      reference: order.reference,
      callbackUrl: `${config.apiUrl}/api/payments/callback`,
      metadata: {
        order_reference: order.reference,
        customer_name: order.customer_name,
        custom_fields: [
          { display_name: 'Order', variable_name: 'order', value: order.reference },
        ],
      },
    });

    await db.run(
      "UPDATE orders SET payment_status='pending', channel='paystack', paystack_reference=?, updated_at=? WHERE id=?",
      [order.reference, db.now(), order.id]
    );

    res.json({
      ok: true,
      authorizationUrl: data.authorization_url,
      reference: order.reference,
      amountKobo: order.total_kobo,
      amountLabel: formatNaira(order.total_kobo),
      mock: Boolean(data.mock),
    });
  })
);

// ---------------------------------------------------------------------------
// Webhook
//
// Mounted in index.js with express.raw() BEFORE any JSON parser. Paystack signs
// the raw bytes with HMAC SHA512 using the secret key; re-serialising the body
// changes those bytes and the signature can then never match.
// ---------------------------------------------------------------------------
async function webhookHandler(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  const signature = req.get('x-paystack-signature');
  const signatureOk = paystack.verifySignature(raw, signature);

  let payload = {};
  try { payload = JSON.parse(raw.toString('utf8')); } catch { /* logged below */ }

  const event = String(payload.event || 'unknown');
  const reference = payload.data && payload.data.reference ? String(payload.data.reference) : null;
  const body = raw.toString('utf8').slice(0, 20000);

  // Signature is checked BEFORE anything is recorded against the real
  // reference. Recording first would let an unsigned request claim the
  // dedupe key for an order and permanently block the genuine webhook that
  // follows it, leaving a paid order stuck unpaid.
  if (!signatureOk) {
    console.warn('[paystack] rejected webhook with bad signature', { event, reference });
    // Logged under a throwaway key so rejects can be reviewed without ever
    // colliding with a real event.
    await db.run(
      `INSERT INTO payment_events (id, provider, event, reference, signature_ok, processed, result, payload, created_at)
       VALUES (?, 'paystack', ?, ?, 0, 1, 'rejected_bad_signature', ?, ?)`,
      [id(), event, `!rejected:${id()}`, body, db.now()]
    );
    return res.sendStatus(401);
  }

  // Only verified events take the dedupe key. A unique-index conflict here
  // means Paystack is retrying an event already handled — expected and safe
  // to ignore. Any other error is a real failure and must not be swallowed:
  // silently returning 200 for it would tell Paystack we processed an event
  // we never actually recorded.
  try {
    await db.run(
      `INSERT INTO payment_events (id, provider, event, reference, signature_ok, processed, result, payload, created_at)
       VALUES (?, 'paystack', ?, ?, 1, 0, '', ?, ?)`,
      [id(), event, reference, body, db.now()]
    );
  } catch (e) {
    if (e.code === PG_UNIQUE_VIOLATION) return res.sendStatus(200);
    console.error('[paystack] failed to record webhook event:', e.message);
    return res.sendStatus(500); // triggers a Paystack retry, as it should
  }

  // Acknowledge quickly; Paystack retries on slow or failed responses.
  res.sendStatus(200);

  if (event !== 'charge.success' || !reference) return;

  try {
    const order = await db.get('SELECT * FROM orders WHERE reference = ?', [reference]);
    if (!order) {
      console.warn('[paystack] webhook for unknown order', reference);
      return;
    }

    // Never trust the amount in the webhook body. Ask Paystack directly.
    const verified = await paystack.verify(reference);
    if (verified.status !== 'success') {
      await mark(reference, 'verify_not_success');
      return;
    }
    const paid = verified.amount == null ? order.total_kobo : Number(verified.amount);
    if (paid < order.total_kobo) {
      // Underpayment: flag it rather than releasing goods.
      await mark(reference, `underpaid:${paid}<${order.total_kobo}`);
      await notifyOwner(
        `UNDERPAID ${order.reference}`,
        `Paystack reports ${formatNaira(paid)} against a total of ${formatNaira(order.total_kobo)}. Not fulfilled.`
      );
      return;
    }

    const r = await fulfil(order, paid, reference);
    await mark(reference, r.alreadyPaid ? 'already_paid' : 'fulfilled');
  } catch (e) {
    console.error('[paystack] webhook processing failed', e);
    await mark(reference, 'error:' + (e && e.message));
  }
}

function mark(reference, result) {
  return db.run(
    "UPDATE payment_events SET processed = 1, result = ? WHERE reference = ? AND event = 'charge.success'",
    [String(result).slice(0, 300), reference]
  );
}

// ---------------------------------------------------------------------------
// Browser callback after payment.
// This is a convenience for the customer, not a source of truth: the webhook
// is authoritative. We still verify here so the page can show a real result.
// ---------------------------------------------------------------------------
router.get('/payments/callback', wrap(async (req, res) => {
  const reference = String(req.query.reference || req.query.trxref || '').toUpperCase();
  const order = reference && await db.get('SELECT * FROM orders WHERE reference = ?', [reference]);
  if (!order) return res.status(404).send(resultPage('Order not found', 'We could not find that payment.', false));

  try {
    const verified = await paystack.verify(reference);
    if (verified.status === 'success') {
      const paid = verified.amount == null ? order.total_kobo : Number(verified.amount);
      if (paid >= order.total_kobo) await fulfil(order, paid, reference);
    }
  } catch (e) {
    console.error('[paystack] callback verify failed', e);
  }

  const fresh = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  const paidOk = fresh.payment_status === 'paid';
  res.send(resultPage(
    paidOk ? 'Payment received' : 'Payment pending',
    paidOk
      ? `Thank you. Order <b>${fresh.reference}</b> is paid and we are on it.`
      : `We have not seen confirmation for <b>${fresh.reference}</b> yet. If money left your account, message us on WhatsApp with this reference and we will sort it.`,
    paidOk
  ));
}));

// ---------------------------------------------------------------------------
// Mock payment page. Development only: config.paystack.mock is forced false
// when NODE_ENV=production, so this cannot be reached on a live server.
// ---------------------------------------------------------------------------
router.get('/payments/mock/:reference', wrap(async (req, res) => {
  if (!config.paystack.mock) throw notFound();
  const reference = String(req.params.reference).toUpperCase();
  const order = await db.get('SELECT * FROM orders WHERE reference = ?', [reference]);
  if (!order) throw notFound('No such order.');
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock payment — ${reference}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#f2efe9;
font:16px/1.6 system-ui,sans-serif;padding:24px}.c{max-width:420px;text-align:center}
.t{background:#7c1015;font-size:11px;letter-spacing:.18em;padding:5px 10px;display:inline-block;text-transform:uppercase}
h1{font-size:26px;margin:14px 0 6px}p{color:#8f8b84}b{color:#f2efe9}
a{display:inline-block;margin-top:18px;background:#f2efe9;color:#0a0a0a;padding:13px 26px;
text-decoration:none;font-size:13px;letter-spacing:.12em;text-transform:uppercase}</style>
<div class="c"><span class="t">Mock mode — no real money</span>
<h1>${formatNaira(order.total_kobo)}</h1>
<p>Simulated Paystack checkout for <b>${reference}</b>.</p>
<a href="/api/payments/callback?reference=${encodeURIComponent(reference)}">Pay now (simulated)</a></div>`);
}));

function resultPage(title, body, ok) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — YnR</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#f2efe9;
font:16px/1.6 system-ui,sans-serif;padding:24px}.c{max-width:460px;text-align:center}
h1{font-size:30px;margin:0 0 12px;color:${ok ? '#f2efe9' : '#a8181d'}}p{color:#8f8b84;margin:0 0 22px}
a{color:#f2efe9;border:1px solid rgba(242,239,233,.3);padding:11px 20px;text-decoration:none;
display:inline-block;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
a:hover{background:#7c1015;border-color:#7c1015}</style>
<div class="c"><h1>${title}</h1><p>${body}</p><a href="${config.siteUrl}">Back to the shop</a></div>`;
}

module.exports = router;
module.exports.webhookHandler = webhookHandler;
