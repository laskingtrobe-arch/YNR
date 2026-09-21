'use strict';
const crypto = require('crypto');
const config = require('./../config');
const { HttpError } = require('../middleware');

const enabled = () => Boolean(config.paystack.secretKey) || config.paystack.mock;

async function call(method, endpoint, body) {
  if (!config.paystack.secretKey) {
    throw new HttpError(503, 'Paystack is not configured on this server.', 'paystack_unconfigured');
  }
  const res = await fetch(config.paystack.base + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + config.paystack.secretKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new HttpError(502, 'Paystack returned an unreadable response.', 'paystack_bad_response');
  }
  if (!res.ok || json.status !== true) {
    const msg = (json && json.message) || `Paystack request failed (${res.status})`;
    throw new HttpError(502, msg, 'paystack_error');
  }
  return json.data;
}

/**
 * Start a transaction. `amountKobo` must be an integer: Paystack charges in
 * the smallest currency unit, so a float here would over- or under-charge.
 */
async function initialize({ email, amountKobo, reference, callbackUrl, metadata }) {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    throw new HttpError(400, 'Payment amount must be a positive integer in kobo.', 'bad_amount');
  }

  if (config.paystack.mock) {
    return {
      mock: true,
      authorization_url: `${config.apiUrl}/api/payments/mock/${encodeURIComponent(reference)}`,
      access_code: 'mock_' + reference,
      reference,
    };
  }

  return call('POST', '/transaction/initialize', {
    email,
    amount: amountKobo,
    reference,
    currency: 'NGN',
    callback_url: callbackUrl,
    metadata,
  });
}

/**
 * Confirm a transaction directly with Paystack. Always call this before
 * marking an order paid: a webhook body or a browser redirect can be forged,
 * this cannot.
 */
async function verify(reference) {
  if (config.paystack.mock) {
    return { status: 'success', reference, amount: null, currency: 'NGN', mock: true };
  }
  return call('GET', '/transaction/verify/' + encodeURIComponent(reference));
}

/**
 * Requests a refund. `amountKobo` omitted means a full refund of whatever
 * the original transaction charged; Paystack rejects an amount larger than
 * that on its own.
 *
 * A refund does NOT complete synchronously — Paystack's own documentation is
 * explicit that refund status should be tracked via their refund.processed /
 * refund.failed webhooks, not the initial response, which normally comes
 * back "pending". This app does not wire those webhooks: the exact shape of
 * their payload could not be verified with confidence, and parsing a
 * guessed field name for a payment webhook is worse than not having it —
 * it would silently never match, leaving a refund that actually completed
 * still shown as pending. fetchRefund() below re-checks status on demand
 * against Paystack directly instead, the same "never trust it, verify it"
 * rule this file already applies to payment confirmation.
 */
async function refund({ transaction, amountKobo, reason }) {
  if (config.paystack.mock) {
    // Real Paystack returns "pending" here too — initiating is not
    // completing. Mirroring that (rather than shortcutting straight to
    // "processed") is what makes fetchRefund()'s pending -> processed
    // transition something the mock flow actually exercises.
    return {
      mock: true,
      id: 'mock_refund_' + transaction,
      status: 'pending',
      amount: amountKobo ?? null,
      transaction,
    };
  }
  const body = { transaction };
  if (amountKobo != null) {
    if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
      throw new HttpError(400, 'Refund amount must be a positive integer in kobo.', 'bad_amount');
    }
    body.amount = amountKobo;
  }
  if (reason) body.reason = String(reason).slice(0, 200);
  return call('POST', '/refund', body);
}

/** Re-checks one refund's current status directly with Paystack. */
async function fetchRefund(refundId) {
  if (config.paystack.mock || String(refundId).startsWith('mock_refund_')) {
    return { mock: true, id: refundId, status: 'processed' };
  }
  return call('GET', '/refund/' + encodeURIComponent(refundId));
}

/**
 * Verify a webhook signature.
 *
 * Paystack signs with HMAC SHA512 (not SHA256) using the SECRET key, over the
 * RAW request body. The route must therefore be mounted with express.raw()
 * before any JSON body parser: re-serializing the body changes the bytes and
 * the signature will never match.
 */
function verifySignature(rawBody, signature) {
  if (!signature || !config.paystack.secretKey) return false;
  const expected = crypto
    .createHmac('sha512', config.paystack.secretKey)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { enabled, initialize, verify, refund, fetchRefund, verifySignature };
