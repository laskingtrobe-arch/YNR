'use strict';
const db = require('../db');
const config = require('../config');
const { id, formatNaira } = require('../lib/util');

/**
 * Every function below that touches the database takes `exec` as its first
 * argument: either the shared `db` module (a plain query, no transaction), or
 * a `tx` object handed in by `db.transaction()`. This is deliberate rather
 * than defaulted, because it is exactly the kind of thing that goes wrong
 * silently: call acquireHold with the pool instead of the transaction it is
 * supposed to be part of, and the hold survives a rollback that was meant to
 * undo it. Making it an explicit, required argument means that mistake shows
 * up as an obvious missing-parameter bug, not a rare production race.
 */

// ---------------------------------------------------------------------------
// Mail
//
// Every message is recorded in the outbox first, delivery or not — that
// keeps development honest and gives admin a real log to check, which is
// exactly the gap this project started with. With SMTP_URL set (see
// services/mail.js), the outbox row is then updated with the real outcome
// instead of staying an intention that was never followed through on.
// ---------------------------------------------------------------------------
const mailer = require('./mail');

async function sendMail(to, subject, body) {
  const row = { id: id(), to_addr: to, subject, body, sent: 0, error: '', created_at: db.now() };
  await db.run(
    `INSERT INTO mail_outbox (id, to_addr, subject, body, sent, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.to_addr, row.subject, row.body, row.sent, row.error, row.created_at]
  );

  if (!mailer.enabled()) {
    console.log(`[mail:outbox] -> ${to} | ${subject}`);
    return { queued: true, delivered: false, id: row.id };
  }

  const result = await mailer.send({ to, subject, text: body });
  await db.run('UPDATE mail_outbox SET sent = ?, error = ? WHERE id = ?',
    [result.delivered ? 1 : 0, result.error || '', row.id]);
  console.log(result.delivered
    ? `[mail:sent] -> ${to} | ${subject}`
    : `[mail:failed] -> ${to} | ${subject} (${result.error})`);
  return { queued: true, delivered: result.delivered, id: row.id };
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
async function acquireHold(exec, productId, orderId) {
  const t = db.now();
  const until = t + config.holdMinutes * 60_000;
  const r = await exec.run(
    `UPDATE products
        SET status = 'held', held_until = ?, held_by = ?, updated_at = ?
      WHERE id = ?
        AND published = 1
        AND ( status = 'available'
              OR (status = 'held' AND (held_until IS NULL OR held_until < ?))
              OR (status = 'held' AND held_by = ?) )`,
    [until, orderId, t, productId, t, orderId]
  );
  return r.changes === 1;
}

async function releaseHold(exec, productId, orderId) {
  await exec.run(
    `UPDATE products
        SET status = 'available', held_until = NULL, held_by = NULL, updated_at = ?
      WHERE id = ? AND status = 'held' AND held_by = ?`,
    [db.now(), productId, orderId]
  );
}

async function releaseOrderHolds(exec, orderId) {
  const rows = await exec.all('SELECT product_id FROM order_items WHERE order_id = ?', [orderId]);
  for (const r of rows) if (r.product_id) await releaseHold(exec, r.product_id, orderId);
}

async function markOrderProductsSold(exec, orderId) {
  const rows = await exec.all('SELECT product_id FROM order_items WHERE order_id = ?', [orderId]);
  for (const r of rows) {
    if (!r.product_id) continue;
    await exec.run(
      `UPDATE products SET status = 'sold', held_until = NULL, held_by = NULL, updated_at = ?
        WHERE id = ?`,
      [db.now(), r.product_id]
    );
  }
}

// Sweep expired holds back to available. Always runs against the shared pool
// directly: it is one statement, not part of any larger unit of work.
async function releaseExpiredHolds() {
  const t = db.now();
  const r = await db.run(
    `UPDATE products
        SET status = 'available', held_until = NULL, held_by = NULL, updated_at = ?
      WHERE status = 'held' AND held_until IS NOT NULL AND held_until < ?`,
    [t, t]
  );
  if (r.changes) console.log(`[holds] released ${r.changes} expired hold(s)`);
  return r.changes;
}

function startHoldSweeper() {
  releaseExpiredHolds().catch((e) => console.error('[holds] sweep failed:', e.message));
  const timer = setInterval(() => {
    releaseExpiredHolds().catch((e) => console.error('[holds] sweep failed:', e.message));
  }, 60_000);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
async function audit(adminId, action, target = '', detail = '') {
  await db.run(
    `INSERT INTO audit_log (id, admin_id, action, target, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id(), adminId || null, action, target, detail, db.now()]
  );
}

module.exports = {
  sendMail, notifyOwner,
  orderMessage, whatsappLink,
  acquireHold, releaseHold, releaseOrderHolds, markOrderProductsSold,
  releaseExpiredHolds, startHoldSweeper,
  audit,
};
