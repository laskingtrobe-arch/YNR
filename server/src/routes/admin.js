'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, now } = require('../db');
const config = require('../config');
const {
  wrap, bad, notFound, conflict, rateLimit, requireAdmin, HttpError,
} = require('../middleware');
const {
  id, token, sha256, slugify, clean, verifyPassword, hashPassword, formatNaira, toKobo,
} = require('../lib/util');
const { audit, releaseOrderHolds, sendMail } = require('../services');

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
  wrap((req, res) => {
    const email = clean(req.body.email, 200).toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email);

    // Same response either way so the endpoint cannot be used to discover
    // which email addresses exist.
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      throw new HttpError(401, 'Email or password is incorrect.', 'bad_credentials');
    }

    const raw = token(32);
    const expires = now() + config.session.ttlHours * 3600_000;
    db.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(raw), user.id, expires, now());

    res.cookie(config.session.cookie, raw, {
      httpOnly: true,
      sameSite: 'strict',   // primary CSRF defence for this cookie
      secure: config.isProd,
      maxAge: config.session.ttlHours * 3600_000,
      path: '/',
    });
    audit(user.id, 'login');
    res.json({ ok: true, admin: { email: user.email } });
  })
);

router.post('/logout', wrap((req, res) => {
  const raw = req.cookies && req.cookies[config.session.cookie];
  if (raw) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(raw));
  res.clearCookie(config.session.cookie, { path: '/' });
  res.json({ ok: true });
}));

router.get('/me', requireAdmin, (req, res) => res.json({ ok: true, admin: req.admin }));

// Everything past this point requires a session.
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/stats', wrap((req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const paid = one("SELECT COALESCE(SUM(total_kobo),0) AS v FROM orders WHERE payment_status='paid'").v;
  res.json({
    ok: true,
    stats: {
      products: one('SELECT COUNT(*) AS v FROM products').v,
      available: one("SELECT COUNT(*) AS v FROM products WHERE status='available'").v,
      held: one("SELECT COUNT(*) AS v FROM products WHERE status='held' AND held_until > ?", now()).v,
      sold: one("SELECT COUNT(*) AS v FROM products WHERE status IN ('sold','repaint_only')").v,
      orders: one('SELECT COUNT(*) AS v FROM orders').v,
      awaiting: one("SELECT COUNT(*) AS v FROM orders WHERE status='pending_confirmation'").v,
      paidOrders: one("SELECT COUNT(*) AS v FROM orders WHERE payment_status='paid'").v,
      revenueKobo: paid,
      revenueLabel: formatNaira(paid),
      unreadMessages: one('SELECT COUNT(*) AS v FROM contact_messages WHERE handled=0').v,
      subscribers: one("SELECT COUNT(*) AS v FROM subscribers WHERE status='confirmed'").v,
      repaints: one('SELECT COUNT(*) AS v FROM repaint_requests WHERE handled=0').v,
    },
  });
}));

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/products', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ORDER BY p.sort, p.created_at`).all();
  res.json({
    ok: true,
    products: rows.map((p) => ({
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
      images: db.prepare('SELECT id, url, alt FROM product_images WHERE product_id=? ORDER BY sort, rowid').all(p.id),
    })),
  });
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

router.post('/products', wrap((req, res) => {
  const d = readProductBody(req.body, null);
  if (db.prepare('SELECT 1 FROM products WHERE slug=?').get(d.slug)) {
    throw conflict('A piece with that web address already exists.', 'slug_taken');
  }
  const pid = id();
  db.prepare(`
    INSERT INTO products (id, slug, name, category_id, price_kobo, description, sizes_json,
      status, sort, published, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(pid, d.slug, d.name, d.categoryId, d.priceKobo, d.description, d.sizes,
      d.status, d.sort, d.published, now(), now());
  audit(req.admin.id, 'product.create', d.slug, d.name);
  res.status(201).json({ ok: true, id: pid, slug: d.slug });
}));

router.patch('/products/:id', wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!existing) throw notFound('No such piece.');
  const d = readProductBody({ ...existing, ...req.body }, existing);

  const clash = db.prepare('SELECT 1 FROM products WHERE slug=? AND id<>?').get(d.slug, existing.id);
  if (clash) throw conflict('Another piece already uses that web address.', 'slug_taken');

  db.prepare(`
    UPDATE products SET slug=?, name=?, category_id=?, price_kobo=?, description=?,
      sizes_json=?, status=?, sort=?, published=?, updated_at=? WHERE id=?`)
    .run(d.slug, d.name, d.categoryId, d.priceKobo, d.description, d.sizes,
      d.status, d.sort, d.published, now(), existing.id);
  audit(req.admin.id, 'product.update', d.slug, d.name);
  res.json({ ok: true });
}));

// One-tap sold / available, the control the shop owner uses most.
router.post('/products/:id/status', wrap((req, res) => {
  const status = String(req.body.status || '');
  if (!PRODUCT_STATUSES.includes(status)) throw bad('Unknown status.', 'status_invalid');
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) throw notFound('No such piece.');
  db.prepare('UPDATE products SET status=?, held_until=NULL, held_by=NULL, updated_at=? WHERE id=?')
    .run(status, now(), p.id);
  audit(req.admin.id, 'product.status', p.slug, status);
  res.json({ ok: true, status });
}));

router.delete('/products/:id', wrap((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) throw notFound('No such piece.');
  const used = db.prepare('SELECT COUNT(*) AS v FROM order_items WHERE product_id=?').get(p.id).v;
  if (used) {
    // Deleting would tear a hole in order history. Unpublish instead.
    db.prepare('UPDATE products SET published=0, updated_at=? WHERE id=?').run(now(), p.id);
    audit(req.admin.id, 'product.unpublish', p.slug, 'had orders');
    return res.json({ ok: true, unpublished: true, message: 'This piece appears in past orders, so it was hidden rather than deleted.' });
  }
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  audit(req.admin.id, 'product.delete', p.slug, p.name);
  res.json({ ok: true, deleted: true });
}));

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.uploads),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 8);
      cb(null, `${Date.now()}-${token(8)}${ext}`);
    },
  }),
  limits: { fileSize: config.uploads.maxBytes, files: 8 },
  fileFilter: (req, file, cb) => {
    if (!config.uploads.allowed.includes(file.mimetype)) {
      return cb(new HttpError(400, 'Images must be JPG, PNG, WebP or AVIF.', 'bad_filetype'));
    }
    cb(null, true);
  },
});

router.post('/products/:id/images', upload.array('images', 8), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) throw notFound('No such piece.');
  const files = req.files || [];
  if (!files.length) throw bad('No image was uploaded.', 'no_file');

  const base = db.prepare('SELECT COALESCE(MAX(sort),-1) AS v FROM product_images WHERE product_id=?').get(p.id).v;
  const added = files.map((f, i) => {
    const url = `/uploads/${f.filename}`;
    const imgId = id();
    db.prepare('INSERT INTO product_images (id, product_id, url, alt, sort) VALUES (?,?,?,?,?)')
      .run(imgId, p.id, url, clean(req.body.alt || p.name, 200), base + 1 + i);
    return { id: imgId, url };
  });
  audit(req.admin.id, 'product.images', p.slug, `${added.length} added`);
  res.status(201).json({ ok: true, images: added });
}));

router.delete('/images/:id', wrap((req, res) => {
  const img = db.prepare('SELECT * FROM product_images WHERE id=?').get(req.params.id);
  if (!img) throw notFound('No such image.');
  db.prepare('DELETE FROM product_images WHERE id=?').run(img.id);
  // Only remove the file if nothing else references it.
  const stillUsed = db.prepare('SELECT COUNT(*) AS v FROM product_images WHERE url=?').get(img.url).v;
  if (!stillUsed && img.url.startsWith('/uploads/')) {
    const f = path.join(config.paths.uploads, path.basename(img.url));
    fs.promises.unlink(f).catch(() => {});
  }
  audit(req.admin.id, 'image.delete', img.product_id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
router.get('/orders', wrap((req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 300').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300').all();

  res.json({
    ok: true,
    orders: rows.map((o) => ({
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
      items: db.prepare('SELECT name_snapshot AS name, size, price_kobo FROM order_items WHERE order_id=?')
        .all(o.id).map((i) => ({ ...i, priceLabel: formatNaira(i.price_kobo) })),
    })),
  });
}));

router.patch('/orders/:id', wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) throw notFound('No such order.');

  const fields = [];
  const vals = [];

  if (req.body.status !== undefined) {
    const s = String(req.body.status);
    if (!ORDER_STATUSES.includes(s)) throw bad('Unknown order status.', 'status_invalid');
    fields.push('status=?'); vals.push(s);
    // Cancelling must hand the piece back to the shop.
    if (s === 'cancelled') releaseOrderHolds(o.id);
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
    if (ps === 'paid') { fields.push('paid_at=?'); vals.push(now()); }
  }
  if (!fields.length) throw bad('Nothing to update.', 'no_changes');

  fields.push('updated_at=?'); vals.push(now(), o.id);
  db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id=?`).run(...vals);
  audit(req.admin.id, 'order.update', o.reference, JSON.stringify(req.body).slice(0, 200));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Inbox, subscribers, repaints, audit
// ---------------------------------------------------------------------------
router.get('/messages', wrap((req, res) => {
  res.json({ ok: true, messages: db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 300').all() });
}));
router.post('/messages/:id/handled', wrap((req, res) => {
  db.prepare('UPDATE contact_messages SET handled=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

router.get('/subscribers', wrap((req, res) => {
  res.json({ ok: true, subscribers: db.prepare('SELECT id,email,status,created_at FROM subscribers ORDER BY created_at DESC LIMIT 1000').all() });
}));

router.get('/repaints', wrap((req, res) => {
  res.json({ ok: true, repaints: db.prepare(`
    SELECT r.*, p.name AS product_name FROM repaint_requests r
      LEFT JOIN products p ON p.id = r.product_id
     ORDER BY r.created_at DESC LIMIT 300`).all() });
}));

router.get('/mail', wrap((req, res) => {
  res.json({ ok: true, mail: db.prepare('SELECT id,to_addr,subject,sent,created_at FROM mail_outbox ORDER BY created_at DESC LIMIT 200').all() });
}));

router.get('/audit', wrap((req, res) => {
  res.json({ ok: true, log: db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all() });
}));

// Announce a new drop to confirmed subscribers.
router.post('/broadcast', rateLimit({ key: 'broadcast', windowMs: 60 * 60_000, max: 5 }), wrap((req, res) => {
  const subject = clean(req.body.subject, 200);
  const body = clean(req.body.body, 8000);
  if (!subject || !body) throw bad('A broadcast needs a subject and a message.', 'fields_required');

  const subs = db.prepare("SELECT email, unsub_token FROM subscribers WHERE status='confirmed'").all();
  for (const s of subs) {
    sendMail(s.email, subject,
      `${body}\n\n—\nStop receiving these: ${config.apiUrl}/api/newsletter/unsubscribe?token=${s.unsub_token}`);
  }
  audit(req.admin.id, 'broadcast', String(subs.length), subject);
  res.json({ ok: true, queued: subs.length });
}));

module.exports = router;
module.exports.hashPassword = hashPassword;
