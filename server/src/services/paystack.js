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

module.exports = { enabled, initialize, verify, verifySignature };
