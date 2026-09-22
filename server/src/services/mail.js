'use strict';
const config = require('../config');

/**
 * Real SMTP delivery. Kept separate from services/index.js's sendMail (which
 * owns the outbox record) so the transport itself — the part that needs a
 * real provider and can be swapped later — is one small, isolated piece.
 *
 * nodemailer.createTransport accepts a full connection URL directly:
 *   smtp://user:pass@smtp.provider.com:587
 * Any SMTP provider works this way — Postmark, SendGrid, Mailgun's SMTP
 * endpoint, Gmail with an app password. Neon does not provide one itself.
 * Built once and reused: creating a new transport per email would reopen a
 * connection for every send.
 */
let transport = null;
function getTransport() {
  if (!config.mail.smtpUrl) return null;
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport(config.mail.smtpUrl);
  }
  return transport;
}

const enabled = () => Boolean(config.mail.smtpUrl);

/**
 * Sends one email. Never throws: a failed send must not take down whatever
 * business action (an order, a contact form) triggered it. The caller
 * receives {delivered, error} and decides what, if anything, to do with a
 * failure — services/index.js records it against the outbox row either way.
 */
async function send({ to, subject, text }) {
  const t = getTransport();
  if (!t) return { delivered: false, error: 'SMTP not configured' };

  try {
    await t.sendMail({ from: config.mail.from, to, subject, text });
    return { delivered: true, error: null };
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    return { delivered: false, error: e.message.slice(0, 300) };
  }
}

module.exports = { enabled, send };
