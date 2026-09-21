'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const {
  wrap, bad, notFound, conflict, rateLimit, requireAdmin, HttpError,
} = require('../middleware');
const {
  id, token, sha256, slugify, clean, isEmail, verifyPassword, hashPassword, formatNaira, toKobo,
} = require('../lib/util');
const { audit, releaseOrderHolds, sendMail } = require('../services');
const paystack = require('../services/paystack');

const router = express.Router();

const ORDER_STATUSES = [
  'draft', 'pending_confirmation', 'confirmed', 'paid',
  'in_production', 'shipped', 'delivered', 'cancelled',
];
const PRODUCT_STATUSES = ['available', 'held', 'sold', 'repaint_only'];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
router.post('/login',
  rateLimit({ key: 'admin-login', windowMs: 15 * 60_000, max: 10 }),
  wrap(async (req, res) => {
    const email = clean(req.body.email, 200).toLowerCase();
    const password = String(req.body.password || '');
    const user = await db.get('SELECT * FROM admin_users WHERE email = ?', [email]);

    // Same response either way so the endpoint cannot be used to discover
    // which email addresses exist.
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      throw new HttpError(401, 'Email or password is incorrect.', 'bad_credentials');
    }

    const raw = token(32);
    const expires = db.now() + config.session.ttlHours * 3600_000;
    await db.run('INSERT INTO sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [sha256(raw), user.id, expires, db.now()]);

    res.cookie(config.session.cookie, raw, {
      httpOnly: true,
      sameSite: 'strict',   // primary CSRF defence for this cookie
      secure: config.isProd,
      maxAge: config.session.ttlHours * 3600_000,
      path: '/',
    });
    await audit(user.id, 'login');
    res.json({ ok: true, admin: { email: user.email } });
  })
);

router.post('/logout', wrap(async (req, res) => {
  const raw = req.cookies && req.cookies[config.session.cookie];
  if (raw) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(raw)]);
  res.clearCookie(config.session.cookie, { path: '/' });
  res.json({ ok: true });
}));

router.get('/me', requireAdmin, (req, res) => res.json({ ok: true, admin: req.admin }));

// Everything past this point requires a session.
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/stats', wrap(async (req, res) => {
  const one = async (sql, ...a) => (await db.get(sql, a)).v;
  const paid = await one("SELECT COALESCE(SUM(total_kobo),0) AS v FROM orders WHERE payment_status='paid'");
  res.json({
    ok: true,
    stats: {
      products: await one('SELECT COUNT(*) AS v FROM products'),
      available: await one("SELECT COUNT(*) AS v FROM products WHERE status='available'"),
      held: await one("SELECT COUNT(*) AS v FROM products WHERE status='held' AND held_until > ?", db.now()),
      sold: await one("SELECT COUNT(*) AS v FROM products WHERE status IN ('sold','repaint_only')"),
      orders: await one('SELECT COUNT(*) AS v FROM orders'),
      awaiting: await one("SELECT COUNT(*) AS v FROM orders WHERE status='pending_confirmation'"),
      paidOrders: await one("SELECT COUNT(*) AS v FROM orders WHERE payment_status='paid'"),
      revenueKobo: paid,
      revenueLabel: formatNaira(paid),
      unreadMessages: await one('SELECT COUNT(*) AS v FROM contact_messages WHERE handled=0'),
      subscribers: await one("SELECT COUNT(*) AS v FROM subscribers WHERE status='confirmed'"),
      repaints: await one('SELECT COUNT(*) AS v FROM repaint_requests WHERE handled=0'),
    },
  });
}));

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/products', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT p.*, c.name AS category_name
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ORDER BY p.sort, p.created_at`);
  const products = await Promise.all(rows.map(async (p) => ({
    id: p.id, slug: p.slug, name: p.name,
    category: p.category_name || '',
    categoryId: p.category_id,
    price: p.price_kobo / 100,
    priceLabel: formatNaira(p.price_kobo),
    description: p.description,
    sizes: JSON.parse(p.sizes_json || '[]'),
    status: p.status,
    heldUntil: p.held_until,
    published: Boolean(p.published),
    sort: p.sort,
    images: await db.all('SELECT id, url, alt FROM product_images WHERE product_id=? ORDER BY sort, seq', [p.id]),
  })));
  res.json({ ok: true, products });
}));

function readProductBody(body, existing) {
  const name = clean(body.name, 160);
  if (!name) throw bad('A piece needs a name.', 'name_required');

  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0) throw bad('Price must be a number in naira.', 'price_invalid');

  const status = PRODUCT_STATUSES.includes(body.status) ? body.status : (existing ? existing.status : 'available');
  let sizes = body.sizes;
  if (typeof sizes === 'string') sizes = sizes.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(sizes)) sizes = existing ? JSON.parse(existing.sizes_json || '[]') : [];

  return {
    name,
    slug: slugify(body.slug || name),
    categoryId: body.categoryId ? String(body.categoryId) : (existing ? existing.category_id : null),
    priceKobo: toKobo(price),
    description: clean(body.description, 4000),
    sizes: JSON.stringify(sizes.slice(0, 20).map((s) => clean(s, 12))),
    status,
    published: body.published === false || body.published === 'false' ? 0 : 1,
    sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : (existing ? existing.sort : 0),
  };
}

router.post('/products', wrap(async (req, res) => {
  const d = readProductBody(req.body, null);
  if (await db.get('SELECT 1 FROM products WHERE slug=?', [d.slug])) {
    throw conflict('A piece with that web address already exists.', 'slug_taken');
  }
  const pid = id();
  await db.run(`
    INSERT INTO products (id, slug, name, category_id, price_kobo, description, sizes_json,
      status, sort, published, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [pid, d.slug, d.name, d.categoryId, d.priceKobo, d.description, d.sizes,
     d.status, d.sort, d.published, db.now(), db.now()]);
  await audit(req.admin.id, 'product.create', d.slug, d.name);
  res.status(201).json({ ok: true, id: pid, slug: d.slug });
}));

router.patch('/products/:id', wrap(async (req, res) => {
  const existing = await db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!existing) throw notFound('No such piece.');
  const d = readProductBody({ ...existing, ...req.body }, existing);

  const clash = await db.get('SELECT 1 FROM products WHERE slug=? AND id<>?', [d.slug, existing.id]);
  if (clash) throw conflict('Another piece already uses that web address.', 'slug_taken');

  await db.run(`
    UPDATE products SET slug=?, name=?, category_id=?, price_kobo=?, description=?,
      sizes_json=?, status=?, sort=?, published=?, updated_at=? WHERE id=?`,
    [d.slug, d.name, d.categoryId, d.priceKobo, d.description, d.sizes,
     d.status, d.sort, d.published, db.now(), existing.id]);
  await audit(req.admin.id, 'product.update', d.slug, d.name);
  res.json({ ok: true });
}));

// One-tap sold / available, the control the shop owner uses most.
router.post('/products/:id/status', wrap(async (req, res) => {
  const status = String(req.body.status || '');
  if (!PRODUCT_STATUSES.includes(status)) throw bad('Unknown status.', 'status_invalid');
  const p = await db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!p) throw notFound('No such piece.');
  await db.run('UPDATE products SET status=?, held_until=NULL, held_by=NULL, updated_at=? WHERE id=?',
    [status, db.now(), p.id]);
  await audit(req.admin.id, 'product.status', p.slug, status);
  res.json({ ok: true, status });
}));

router.delete('/products/:id', wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!p) throw notFound('No such piece.');
  const used = (await db.get('SELECT COUNT(*) AS v FROM order_items WHERE product_id=?', [p.id])).v;
  if (used) {
    // Deleting would tear a hole in order history. Unpublish instead.
    await db.run('UPDATE products SET published=0, updated_at=? WHERE id=?', [db.now(), p.id]);
    await audit(req.admin.id, 'product.unpublish', p.slug, 'had orders');
    return res.json({ ok: true, unpublished: true, message: 'This piece appears in past orders, so it was hidden rather than deleted.' });
  }
  await db.run('DELETE FROM products WHERE id=?', [p.id]);
  await audit(req.admin.id, 'product.delete', p.slug, p.name);
  res.json({ ok: true, deleted: true });
}));

// ---------------------------------------------------------------------------
// Image upload
//
// Files are held in memory, not written to disk as-is: every upload is
// resized and re-encoded through sharp first, so a 6MB phone photo never
// reaches the storefront at full size. Capped at 1600px on the long edge —
// comfortably more than any real display needs — and re-encoded as
// mozjpeg, which is a large, predictable size win over whatever the phone
// camera produced. Output is normalised to JPEG regardless of the upload
// format: these are photographs of garments, not graphics that need
// transparency, and one predictable output format is simpler to reason
// about than preserving four different input formats end to end.
// ---------------------------------------------------------------------------
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 82;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 8 },
  fileFilter: (req, file, cb) => {
    if (!config.uploads.allowed.includes(file.mimetype)) {
      return cb(new HttpError(400, 'Images must be JPG, PNG, WebP or AVIF.', 'bad_filetype'));
    }
    cb(null, true);
  },
});

async function resizeToFile(buffer) {
  const sharp = require('sharp');
  const filename = `${Date.now()}-${token(8)}.jpg`;
  const out = path.join(config.paths.uploads, filename);
  await sharp(buffer)
    .rotate() // apply EXIF orientation before stripping metadata, or sideways phone photos would stay sideways
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toFile(out);
  return filename;
}

router.post('/products/:id/images', upload.array('images', 8), wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!p) throw notFound('No such piece.');
  const files = req.files || [];
  if (!files.length) throw bad('No image was uploaded.', 'no_file');

  const base = (await db.get('SELECT COALESCE(MAX(sort),-1) AS v FROM product_images WHERE product_id=?', [p.id])).v;
  const added = [];
  for (let i = 0; i < files.length; i++) {
    let filename;
    try {
      filename = await resizeToFile(files[i].buffer);
    } catch (e) {
      throw new HttpError(400, `"${files[i].originalname}" could not be processed as an image.`, 'bad_image');
    }
    const url = `/uploads/${filename}`;
    const imgId = id();
    await db.run('INSERT INTO product_images (id, product_id, url, alt, sort) VALUES (?,?,?,?,?)',
      [imgId, p.id, url, clean(req.body.alt || p.name, 200), base + 1 + i]);
    added.push({ id: imgId, url });
  }
  await audit(req.admin.id, 'product.images', p.slug, `${added.length} added`);
  res.status(201).json({ ok: true, images: added });
}));

router.delete('/images/:id', wrap(async (req, res) => {
  const img = await db.get('SELECT * FROM product_images WHERE id=?', [req.params.id]);
  if (!img) throw notFound('No such image.');
  await db.run('DELETE FROM product_images WHERE id=?', [img.id]);
  // Only remove the file if nothing else references it.
  const stillUsed = (await db.get('SELECT COUNT(*) AS v FROM product_images WHERE url=?', [img.url])).v;
  if (!stillUsed && img.url.startsWith('/uploads/')) {
    const f = path.join(config.paths.uploads, path.basename(img.url));
    fs.promises.unlink(f).catch(() => {});
  }
  await audit(req.admin.id, 'image.delete', img.product_id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
router.get('/orders', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rows = status
    ? await db.all('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 300', [status])
    : await db.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300');

  const orders = await Promise.all(rows.map(async (o) => ({
    id: o.id, reference: o.reference, status: o.status, channel: o.channel,
    paymentStatus: o.payment_status,
    name: o.customer_name, email: o.customer_email, phone: o.customer_phone,
    address: [o.address_line, o.city, o.state, o.country].filter(Boolean).join(', '),
    zone: o.zone_code, notes: o.notes,
    totalKobo: o.total_kobo, totalLabel: formatNaira(o.total_kobo),
    subtotalLabel: formatNaira(o.subtotal_kobo),
    deliveryLabel: o.delivery_kobo ? formatNaira(o.delivery_kobo) : 'TBC',
    trackingRef: o.tracking_ref,
    createdAt: o.created_at,
    items: (await db.all('SELECT name_snapshot AS name, size, price_kobo FROM order_items WHERE order_id=? ORDER BY seq', [o.id]))
      .map((i) => ({ ...i, priceLabel: formatNaira(i.price_kobo) })),
  })));
  res.json({ ok: true, orders });
}));

router.patch('/orders/:id', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!o) throw notFound('No such order.');

  const fields = [];
  const vals = [];
  const cancelling = req.body.status === 'cancelled';

  if (req.body.status !== undefined) {
    const s = String(req.body.status);
    if (!ORDER_STATUSES.includes(s)) throw bad('Unknown order status.', 'status_invalid');
    fields.push('status=?'); vals.push(s);
  }
  if (req.body.trackingRef !== undefined) {
    fields.push('tracking_ref=?'); vals.push(clean(req.body.trackingRef, 120));
  }
  if (req.body.deliveryFee !== undefined) {
    const fee = toKobo(Number(req.body.deliveryFee) || 0);
    fields.push('delivery_kobo=?', 'total_kobo=?');
    vals.push(fee, o.subtotal_kobo + fee);
  }
  if (req.body.paymentStatus !== undefined) {
    const ps = String(req.body.paymentStatus);
    if (!['unpaid', 'pending', 'paid', 'refunded'].includes(ps)) throw bad('Unknown payment status.', 'pay_status_invalid');
    fields.push('payment_status=?'); vals.push(ps);
    if (ps === 'paid') { fields.push('paid_at=?'); vals.push(db.now()); }
  }
  if (!fields.length) throw bad('Nothing to update.', 'no_changes');

  fields.push('updated_at=?'); vals.push(db.now(), o.id);
  const updateSql = `UPDATE orders SET ${fields.join(', ')} WHERE id=?`;

  if (cancelling) {
    // Cancelling must hand the piece back to the shop. Both writes happen on
    // one connection so a crash between them cannot leave a released hold
    // paired with a still-not-cancelled order, or the reverse.
    await db.transaction(async (tx) => {
      await releaseOrderHolds(tx, o.id);
      await tx.run(updateSql, vals);
    });
  } else {
    await db.run(updateSql, vals);
  }

  await audit(req.admin.id, 'order.update', o.reference, JSON.stringify(req.body).slice(0, 200));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Refunds
//
// Initiating one only ever returns "pending" from Paystack — it is not done
// at that point, just requested. /refund/check re-verifies directly against
// Paystack rather than trusting anything client-side, the same rule this
// app already applies to payment confirmation. There is no webhook-driven
// auto-completion here: see the long comment on paystack.refund() for why.
// ---------------------------------------------------------------------------
router.post('/orders/:id/refund', rateLimit({ key: 'refund', windowMs: 60_000, max: 10 }), wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!o) throw notFound('No such order.');
  if (o.payment_status !== 'paid') throw conflict('Only a paid order can be refunded.', 'not_paid');
  if (o.refund_id) throw conflict('A refund has already been requested for this order.', 'refund_exists');

  const requestedKobo = req.body.amount !== undefined ? toKobo(Number(req.body.amount) || 0) : undefined;
  if (requestedKobo !== undefined && requestedKobo > o.total_kobo) {
    throw bad('Refund amount cannot exceed what the order was paid.', 'amount_too_high');
  }

  const result = await paystack.refund({
    transaction: o.paystack_reference || o.reference,
    amountKobo: requestedKobo,
    reason: clean(req.body.reason, 200) || 'customer_request',
  });

  await db.run(
    `UPDATE orders SET refund_id=?, refund_status=?, refunded_kobo=?, refund_requested_at=?, updated_at=?
      WHERE id=?`,
    [String(result.id), result.status, requestedKobo ?? o.total_kobo, db.now(), db.now(), o.id]
  );
  await audit(req.admin.id, 'order.refund_requested', o.reference, `${result.status} (${result.id})`);
  res.status(201).json({ ok: true, refund: { id: result.id, status: result.status } });
}));

router.post('/orders/:id/refund/check', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!o) throw notFound('No such order.');
  if (!o.refund_id) throw notFound('No refund has been requested for this order.');

  const result = await paystack.fetchRefund(o.refund_id);
  const nowProcessed = result.status === 'processed' && o.refund_status !== 'processed';

  await db.run(
    `UPDATE orders SET refund_status=?, payment_status=?, updated_at=? WHERE id=?`,
    [result.status, nowProcessed ? 'refunded' : o.payment_status, db.now(), o.id]
  );
  if (nowProcessed) await audit(req.admin.id, 'order.refunded', o.reference, String(o.refund_id));
  res.json({ ok: true, refund: { id: o.refund_id, status: result.status } });
}));

// ---------------------------------------------------------------------------
// Inbox, subscribers, repaints, audit
// ---------------------------------------------------------------------------
router.get('/messages', wrap(async (req, res) => {
  res.json({ ok: true, messages: await db.all('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 300') });
}));
router.post('/messages/:id/handled', wrap(async (req, res) => {
  await db.run('UPDATE contact_messages SET handled=1 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

router.get('/subscribers', wrap(async (req, res) => {
  res.json({ ok: true, subscribers: await db.all('SELECT id,email,status,created_at FROM subscribers ORDER BY created_at DESC LIMIT 1000') });
}));

router.get('/repaints', wrap(async (req, res) => {
  res.json({ ok: true, repaints: await db.all(`
    SELECT r.*, p.name AS product_name FROM repaint_requests r
      LEFT JOIN products p ON p.id = r.product_id
     ORDER BY r.created_at DESC LIMIT 300`) });
}));

router.get('/mail', wrap(async (req, res) => {
  res.json({ ok: true, mail: await db.all('SELECT id,to_addr,subject,sent,created_at FROM mail_outbox ORDER BY created_at DESC LIMIT 200') });
}));

router.get('/audit', wrap(async (req, res) => {
  res.json({ ok: true, log: await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200') });
}));

// Which pieces get looked at, and how many viewers click through to
// WhatsApp — the two questions this was actually built to answer, not a
// full analytics dashboard.
router.get('/analytics', wrap(async (req, res) => {
  const day = 86_400_000;
  const since7 = db.now() - 7 * day;
  const since30 = db.now() - 30 * day;

  const count = async (type, since) => (await db.get(
    'SELECT COUNT(*) AS v FROM analytics_events WHERE type=? AND created_at >= ?', [type, since]
  )).v;

  const topProducts = await db.all(`
    SELECT slug, COUNT(*) AS views FROM analytics_events
     WHERE type = 'product_view' AND slug <> '' AND created_at >= ?
     GROUP BY slug ORDER BY views DESC LIMIT 10`, [since30]);

  // Current product names, joined in JS rather than SQL so a renamed or
  // removed piece does not blank out its own history in the report.
  const names = await db.all('SELECT slug, name FROM products');
  const nameBySlug = Object.fromEntries(names.map((p) => [p.slug, p.name]));

  res.json({
    ok: true,
    analytics: {
      pageViews7d: await count('page_view', since7),
      pageViews30d: await count('page_view', since30),
      whatsappClicks7d: await count('whatsapp_click', since7),
      whatsappClicks30d: await count('whatsapp_click', since30),
      topProducts: topProducts.map((p) => ({ slug: p.slug, name: nameBySlug[p.slug] || p.slug, views: p.views })),
    },
  });
}));

// ---------------------------------------------------------------------------
// Privacy (NDPA 2023) — access and erasure, keyed by email
//
// This shop has no customer accounts; everything is tracked by the email a
// person gave on an order, a message or a subscription. So a data-subject
// request is handled the way support already runs here — a customer reaches
// out (WhatsApp, email), the owner looks them up and actions it — rather
// than a public self-service flow, which for an unauthenticated *deletion*
// endpoint would need its own identity-verification step (a confirmation
// link, its own token table, its own abuse-rate-limiting) to be safe at all.
// That is real scope this app does not need yet: it is not a substitute for
// this admin-mediated path, it is a second flow on top of it.
//
// Erasure does not touch orders wholesale: an order is also a transaction
// record, and Nigerian business record-keeping practice — like most data
// protection regimes' own carve-outs — expects those to be retained even
// after an erasure request. So an order's personal fields are anonymised in
// place (name, email, phone, address) while the order itself, its items and
// its totals stay, preserving accounting history. Everything else that is
// purely personal — a contact message, a repaint request, a newsletter
// subscription — is deleted outright.
// ---------------------------------------------------------------------------
router.get('/privacy/lookup', wrap(async (req, res) => {
  const email = clean(req.query.email, 200).toLowerCase();
  if (!isEmail(email)) throw bad('That email address does not look right.', 'email_invalid');

  const [orders, messages, repaints, subscriber] = await Promise.all([
    db.all(`SELECT reference, status, customer_name, customer_phone, address_line, city, state,
                    total_kobo, created_at
               FROM orders WHERE LOWER(customer_email) = ? ORDER BY created_at DESC`, [email]),
    db.all('SELECT subject, message, created_at FROM contact_messages WHERE LOWER(email) = ? ORDER BY created_at DESC', [email]),
    db.all('SELECT name, note, created_at FROM repaint_requests WHERE LOWER(email) = ? ORDER BY created_at DESC', [email]),
    db.get('SELECT status, created_at FROM subscribers WHERE email = ?', [email]),
  ]);

  await audit(req.admin.id, 'privacy.lookup', email);
  res.json({ ok: true, email, data: { orders, messages, repaints, subscriber: subscriber || null } });
}));

router.post('/privacy/erase',
  rateLimit({ key: 'privacy-erase', windowMs: 60_000, max: 10 }),
  wrap(async (req, res) => {
    const email = clean(req.body.email, 200).toLowerCase();
    if (!isEmail(email)) throw bad('That email address does not look right.', 'email_invalid');

    const REDACTED = '[erased]';
    const counts = await db.transaction(async (tx) => {
      const ordersHit = await tx.run(
        `UPDATE orders SET customer_name=?, customer_email=?, customer_phone=?,
                            address_line=?, city=?, state=?, notes=?, updated_at=?
          WHERE LOWER(customer_email) = ?`,
        [REDACTED, `erased-${db.now()}@ynr.local`, '', '', '', '', '', db.now(), email]
      );
      const messagesHit = await tx.run('DELETE FROM contact_messages WHERE LOWER(email) = ?', [email]);
      const repaintsHit = await tx.run('DELETE FROM repaint_requests WHERE LOWER(email) = ?', [email]);
      const subsHit = await tx.run('DELETE FROM subscribers WHERE email = ?', [email]);
      return {
        orders: ordersHit.changes, messages: messagesHit.changes,
        repaints: repaintsHit.changes, subscriber: subsHit.changes,
      };
    });

    await audit(req.admin.id, 'privacy.erase', email, JSON.stringify(counts));
    res.json({ ok: true, erased: counts });
  })
);

// Announce a new drop to confirmed subscribers.
router.post('/broadcast', rateLimit({ key: 'broadcast', windowMs: 60 * 60_000, max: 5 }), wrap(async (req, res) => {
  const subject = clean(req.body.subject, 200);
  const body = clean(req.body.body, 8000);
  if (!subject || !body) throw bad('A broadcast needs a subject and a message.', 'fields_required');

  const subs = await db.all("SELECT email, unsub_token FROM subscribers WHERE status='confirmed'");
  for (const s of subs) {
    await sendMail(s.email, subject,
      `${body}\n\n—\nStop receiving these: ${config.apiUrl}/api/newsletter/unsubscribe?token=${s.unsub_token}`);
  }
  await audit(req.admin.id, 'broadcast', String(subs.length), subject);
  res.json({ ok: true, queued: subs.length });
}));

module.exports = router;
module.exports.hashPassword = hashPassword;
