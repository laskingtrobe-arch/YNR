'use strict';
const express = require('express');
const { db, now } = require('../db');
const { wrap, bad, notFound, conflict, rateLimit, honeypot } = require('../middleware');
const { id, orderRef, isEmail, clean, formatNaira } = require('../lib/util');
const { acquireHold, releaseOrderHolds, orderMessage, whatsappLink, notifyOwner, sendMail } = require('../services');

const router = express.Router();

function itemsFor(orderId) {
  return db.prepare(
    'SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid'
  ).all(orderId);
}

function publicOrder(order) {
  const items = itemsFor(order.id);
  return {
    reference: order.reference,
    status: order.status,
    channel: order.channel,
    paymentStatus: order.payment_status,
    customer: {
      name: order.customer_name,
      email: order.customer_email,
      phone: order.customer_phone,
    },
    delivery: {
      addressLine: order.address_line,
      city: order.city,
      state: order.state,
      country: order.country,
      zone: order.zone_code,
      feeKobo: order.delivery_kobo,
      feeLabel: order.delivery_kobo
        ? formatNaira(order.delivery_kobo)
        : 'To be confirmed',
    },
    items: items.map((i) => ({
      name: i.name_snapshot,
      size: i.size,
      priceKobo: i.price_kobo,
      priceLabel: formatNaira(i.price_kobo),
      image: i.image_snapshot,
    })),
    subtotalKobo: order.subtotal_kobo,
    subtotalLabel: formatNaira(order.subtotal_kobo),
    totalKobo: order.total_kobo,
    totalLabel: formatNaira(order.total_kobo),
    createdAt: order.created_at,
  };
}

/**
 * Create an order.
 *
 * The order is written down BEFORE the customer is handed to WhatsApp or to
 * Paystack. That ordering is the whole point: previously checkout opened a
 * chat and recorded nothing at all.
 */
router.post('/orders',
  rateLimit({ key: 'orders', windowMs: 10 * 60_000, max: 12 }),
  honeypot(),
  wrap((req, res) => {
    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) throw bad('Your bag is empty.', 'empty_bag');
    if (rawItems.length > 20) throw bad('That is too many items for one order.', 'too_many_items');

    const name = clean(body.name, 120);
    const email = clean(body.email, 200);
    const phone = clean(body.phone, 40);
    if (!name) throw bad('Please enter your name.', 'name_required');
    if (!isEmail(email)) throw bad('Please enter a valid email address.', 'email_invalid');
    if (phone.replace(/\D/g, '').length < 7) throw bad('Please enter a reachable phone number.', 'phone_invalid');

    const channel = body.channel === 'paystack' ? 'paystack' : 'whatsapp';

    // Resolve the delivery zone. A NULL fee means "quoted by a human", which
    // is how YnR actually prices anything outside Abuja.
    let zone = null;
    if (body.zone) {
      zone = db.prepare('SELECT * FROM delivery_zones WHERE code = ? AND active = 1').get(String(body.zone));
      if (!zone) throw bad('Please choose a delivery area.', 'zone_invalid');
    }
    // Paying online requires a known total, so the fee cannot be pending.
    if (channel === 'paystack' && (!zone || zone.fee_kobo == null)) {
      throw bad(
        'Delivery to that area is quoted on WhatsApp, so it cannot be paid for online yet. ' +
        'Choose WhatsApp checkout and we will confirm your total.',
        'zone_needs_quote'
      );
    }

    const orderId = id();
    let reference = orderRef();
    // Collisions are vanishingly unlikely, but a duplicate reference would be
    // a genuine mess, so confirm rather than assume.
    for (let i = 0; i < 5 && db.prepare('SELECT 1 FROM orders WHERE reference = ?').get(reference); i++) {
      reference = orderRef();
    }

    const t = now();
    let created;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO orders (id, reference, status, channel, customer_name, customer_email,
           customer_phone, address_line, city, state, country, zone_code, notes,
           subtotal_kobo, delivery_kobo, total_kobo, payment_status, created_at, updated_at)
         VALUES (?, ?, 'pending_confirmation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'unpaid', ?, ?)`
      ).run(orderId, reference, channel, name, email, phone,
        clean(body.addressLine, 300), clean(body.city, 120), clean(body.state, 120),
        clean(body.country, 120) || 'Nigeria', zone ? zone.code : null,
        clean(body.notes, 1000), t, t);

      let subtotal = 0;
      for (const raw of rawItems) {
        const slug = clean(raw && raw.slug, 90);
        const product = db.prepare('SELECT * FROM products WHERE slug = ? AND published = 1').get(slug);
        if (!product) throw notFound(`We could not find "${slug}".`);

        if (product.status === 'sold' || product.status === 'repaint_only') {
          throw conflict(
            `"${product.name}" has already sold. It is one-of-one, but you can ask us to repaint it.`,
            'already_sold'
          );
        }

        // Atomic claim. If this fails, someone else is mid-checkout with it.
        if (!acquireHold(product.id, orderId)) {
          throw conflict(
            `"${product.name}" is being checked out by someone else right now. ` +
            `It frees up shortly if they do not complete the order.`,
            'held_by_other'
          );
        }

        const sizes = JSON.parse(product.sizes_json || '[]');
        let size = clean(raw && raw.size, 12);
        if (sizes.length && !sizes.includes(size)) size = sizes[0];

        const img = db.prepare(
          'SELECT url FROM product_images WHERE product_id = ? ORDER BY sort, rowid LIMIT 1'
        ).get(product.id);

        db.prepare(
          `INSERT INTO order_items (id, order_id, product_id, name_snapshot, size, price_kobo, image_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id(), orderId, product.id, product.name, size, product.price_kobo, img ? img.url : '');

        subtotal += product.price_kobo;
      }

      const deliveryKobo = zone && zone.fee_kobo != null ? zone.fee_kobo : 0;
      db.prepare(
        'UPDATE orders SET subtotal_kobo = ?, delivery_kobo = ?, total_kobo = ?, updated_at = ? WHERE id = ?'
      ).run(subtotal, deliveryKobo, subtotal + deliveryKobo, now(), orderId);

      db.exec('COMMIT');
      created = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    } catch (e) {
      db.exec('ROLLBACK');
      // The rollback undoes the rows; holds are separate writes, so clear them too.
      try { releaseOrderHolds(orderId); } catch { /* nothing left to release */ }
      throw e;
    }

    const items = itemsFor(orderId);
    const waText = orderMessage(created, items);

    notifyOwner(
      `New order ${reference} — ${formatNaira(created.total_kobo)}`,
      `${name} (${phone}, ${email})\n\n${waText}`
    );
    sendMail(
      email,
      `Your YnR order ${reference}`,
      `Hi ${name},\n\nWe have your order ${reference}.\n\n${waText}\n\n` +
      `Nothing is charged until we confirm with you.\n\n— YnR`
    );

    res.status(201).json({
      ok: true,
      order: publicOrder(created),
      whatsappUrl: whatsappLink(waText),
    });
  })
);

// Customer-facing lookup. Reference only, no account needed. References are
// random rather than sequential, so they cannot be walked.
router.get('/orders/:reference',
  rateLimit({ key: 'order-lookup', windowMs: 60_000, max: 30 }),
  wrap((req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE reference = ?')
      .get(String(req.params.reference).toUpperCase());
    if (!order) throw notFound('No order with that reference.');
    res.json({ ok: true, order: publicOrder(order) });
  })
);

module.exports = router;
module.exports.publicOrder = publicOrder;
module.exports.itemsFor = itemsFor;
