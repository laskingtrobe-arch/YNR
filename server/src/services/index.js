'use strict';
const { db, now } = require('../db');
const config = require('../config');
const { id, formatNaira } = require('../lib/util');

// ---------------------------------------------------------------------------
// Mail
//
// With no SMTP transport configured, mail is persisted to the outbox and
// logged. That keeps development honest: messages are visibly recorded rather
// than silently discarded, which is exactly the bug this project started with.
// ---------------------------------------------------------------------------
function sendMail(to, subject, body) {
  const row = {
    id: id(), to_addr: to, subject, body,
    sent: 0, error: '', created_at: now(),
  };
  db.prepare(
    `INSERT INTO mail_outbox (id, to_addr, subject, body, sent, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.to_addr, row.subject, row.body, row.sent, row.error, row.created_at);

  if (!config.mail.smtpUrl) {
    console.log(`[mail:outbox] -> ${to} | ${subject}`);
    return { queued: true, delivered: false, id: row.id };
  }
  // Real SMTP delivery plugs in here (nodemailer or an HTTP mail API).
  // Left unwired deliberately rather than faking a send.
  console.log(`[mail:pending-transport] -> ${to} | ${subject}`);
  return { queued: true, delivered: false, id: row.id };
}

function notifyOwner(subject, body) {
  return sendMail(config.mail.ownerTo, subject, body);
}

// ---------------------------------------------------------------------------
// WhatsApp deep links
// ---------------------------------------------------------------------------
function orderMessage(order, items) {
  const lines = items.map(
    (i) => `• ${i.name_snapshot}${i.size ? ' — Size ' + i.size : ''} — ${formatNaira(i.price_kobo)}`
  );
  return [
    `Hi YnR, I'd like to order (ref ${order.reference}):`,
    '',
    ...lines,
    '',
    `Subtotal: ${formatNaira(order.subtotal_kobo)}`,
    order.delivery_kobo
      ? `Delivery: ${formatNaira(order.delivery_kobo)}`
      : '(Delivery to be confirmed)',
    `Total: ${formatNaira(order.total_kobo)}`,
  ].join('\n');
}

function whatsappLink(text) {
  return `https://wa.me/${config.whatsappNumber}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------
// Holds
//
// A one-of-one piece must never be promised to two people. Acquisition is a
// single conditional UPDATE so the check and the claim cannot interleave.
// ---------------------------------------------------------------------------
function acquireHold(productId, orderId) {
  const t = now();
  const until = t + config.holdMinutes * 60_000;
  const r = db.prepare(
    `UPDATE products
        SET status = 'held', held_until = ?, held_by = ?, updated_at = ?
      WHERE id = ?
        AND published = 1
        AND ( status = 'available'
              OR (status = 'held' AND (held_until IS NULL OR held_until < ?))
              OR (status = 'held' AND held_by = ?) )`
  ).run(until, orderId, t, productId, t, orderId);
  return r.changes === 1;
}

function releaseHold(productId, orderId) {
  db.prepare(
    `UPDATE products
        SET status = 'available', held_until = NULL, held_by = NULL, updated_at = ?
      WHERE id = ? AND status = 'held' AND held_by = ?`
  ).run(now(), productId, orderId);
}

function releaseOrderHolds(orderId) {
  const rows = db.prepare('SELECT product_id FROM order_items WHERE order_id = ?').all(orderId);
  for (const r of rows) if (r.product_id) releaseHold(r.product_id, orderId);
}

function markOrderProductsSold(orderId) {
  const rows = db.prepare('SELECT product_id FROM order_items WHERE order_id = ?').all(orderId);
  for (const r of rows) {
    if (!r.product_id) continue;
    db.prepare(
      `UPDATE products SET status = 'sold', held_until = NULL, held_by = NULL, updated_at = ?
        WHERE id = ?`
    ).run(now(), r.product_id);
  }
}

// Sweep expired holds back to available.
function releaseExpiredHolds() {
  const r = db.prepare(
    `UPDATE products
        SET status = 'available', held_until = NULL, held_by = NULL, updated_at = ?
      WHERE status = 'held' AND held_until IS NOT NULL AND held_until < ?`
  ).run(now(), now());
  if (r.changes) console.log(`[holds] released ${r.changes} expired hold(s)`);
  return r.changes;
}

function startHoldSweeper() {
  releaseExpiredHolds();
  const timer = setInterval(releaseExpiredHolds, 60_000);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
function audit(adminId, action, target = '', detail = '') {
  db.prepare(
    `INSERT INTO audit_log (id, admin_id, action, target, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id(), adminId || null, action, target, detail, now());
}

module.exports = {
  sendMail, notifyOwner,
  orderMessage, whatsappLink,
  acquireHold, releaseHold, releaseOrderHolds, markOrderProductsSold,
  releaseExpiredHolds, startHoldSweeper,
  audit,
};
