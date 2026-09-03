'use strict';
const express = require('express');
const { db, now } = require('../db');
const { wrap, bad, notFound, rateLimit, honeypot } = require('../middleware');
const { id, isEmail, clean, token, formatNaira } = require('../lib/util');
const { sendMail, notifyOwner } = require('../services');
const config = require('../config');

const router = express.Router();

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------
function imagesFor(productId) {
  return db.prepare(
    'SELECT url, alt FROM product_images WHERE product_id = ? ORDER BY sort, rowid'
  ).all(productId);
}

function shape(p) {
  const imgs = imagesFor(p.id);
  const held = p.status === 'held' && p.held_until && p.held_until > now();
  return {
    slug: p.slug,
    name: p.name,
    category: p.category_name || '',
    price: p.price_kobo / 100,
    priceKobo: p.price_kobo,
    priceLabel: formatNaira(p.price_kobo),
    description: p.description,
    sizes: JSON.parse(p.sizes_json || '[]'),
    // 'held' is deliberately reported as available: another shopper should be
    // able to enquire, they just cannot complete checkout while it is reserved.
    status: p.status === 'held' && !held ? 'available' : p.status,
    isAvailable: p.status === 'available' || (p.status === 'held' && !held),
    isReserved: Boolean(held),
    isSold: p.status === 'sold' || p.status === 'repaint_only',
    canRepaint: p.status === 'sold' || p.status === 'repaint_only',
    images: imgs,
    image: imgs.length ? imgs[0].url : '',
  };
}

const SELECT_PRODUCT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
router.get('/products', wrap((req, res) => {
  const params = [];
  let sql = SELECT_PRODUCT + ' WHERE p.published = 1';
  if (req.query.category) {
    sql += ' AND c.slug = ?';
    params.push(String(req.query.category));
  }
  sql += ' ORDER BY p.sort, p.created_at';
  const rows = db.prepare(sql).all(...params);
  res.json({ ok: true, products: rows.map(shape) });
}));

router.get('/products/:slug', wrap((req, res) => {
  const row = db.prepare(SELECT_PRODUCT + ' WHERE p.slug = ? AND p.published = 1')
    .get(req.params.slug);
  if (!row) throw notFound('That piece does not exist.');

  const related = db.prepare(
    SELECT_PRODUCT + ' WHERE p.published = 1 AND p.slug != ? ORDER BY p.sort LIMIT 3'
  ).all(req.params.slug);

  res.json({ ok: true, product: shape(row), related: related.map(shape) });
}));

router.get('/categories', wrap((req, res) => {
  const rows = db.prepare('SELECT slug, name FROM categories ORDER BY sort, name').all();
  res.json({ ok: true, categories: rows });
}));

// ---------------------------------------------------------------------------
// Delivery zones
// ---------------------------------------------------------------------------
router.get('/delivery-zones', wrap((req, res) => {
  const rows = db.prepare(
    'SELECT code, label, fee_kobo, note FROM delivery_zones WHERE active = 1 ORDER BY sort'
  ).all();
  res.json({
    ok: true,
    zones: rows.map((z) => ({
      code: z.code,
      label: z.label,
      fee: z.fee_kobo == null ? null : z.fee_kobo / 100,
      feeKobo: z.fee_kobo,
      feeLabel: z.fee_kobo == null ? 'Quoted on WhatsApp' : formatNaira(z.fee_kobo),
      note: z.note,
      quoted: z.fee_kobo == null,
    })),
  });
}));

// ---------------------------------------------------------------------------
// Contact  (previously this form threw every message away)
// ---------------------------------------------------------------------------
router.post('/contact',
  rateLimit({ key: 'contact', windowMs: 10 * 60_000, max: 5 }),
  honeypot(),
  wrap((req, res) => {
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 200);
    const subject = clean(req.body.subject, 200);
    const message = clean(req.body.message, 5000);

    if (!name) throw bad('Please tell us your name.', 'name_required');
    if (!isEmail(email)) throw bad('That email address does not look right.', 'email_invalid');
    if (!subject) throw bad('Please add a subject.', 'subject_required');
    if (message.length < 5) throw bad('Please write a slightly longer message.', 'message_short');

    const rowId = id();
    db.prepare(
      `INSERT INTO contact_messages (id, name, email, subject, message, handled, ip, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(rowId, name, email, subject, message, clean(req.ip, 60), now());

    notifyOwner(
      `New message from ${name}: ${subject}`,
      `${name} <${email}> wrote:\n\n${message}`
    );
    sendMail(
      email,
      'We got your message — YnR',
      `Hi ${name},\n\nThanks for reaching out. We have your message and will reply soon.\n` +
      `For a faster answer you can also reach us on WhatsApp.\n\n— YnR, Mpape, Abuja`
    );

    res.json({ ok: true, message: 'Message received. We will reply soon.' });
  })
);

// ---------------------------------------------------------------------------
// Newsletter  (double opt-in)
// ---------------------------------------------------------------------------
router.post('/newsletter',
  rateLimit({ key: 'newsletter', windowMs: 10 * 60_000, max: 5 }),
  honeypot(),
  wrap((req, res) => {
    const email = clean(req.body.email, 200).toLowerCase();
    if (!isEmail(email)) throw bad('That email address does not look right.', 'email_invalid');

    const existing = db.prepare('SELECT * FROM subscribers WHERE email = ?').get(email);
    if (existing && existing.status === 'confirmed') {
      return res.json({ ok: true, message: 'You are already on the list.' });
    }

    const confirmToken = token(24);
    if (existing) {
      db.prepare('UPDATE subscribers SET status = ?, confirm_token = ? WHERE id = ?')
        .run('pending', confirmToken, existing.id);
    } else {
      db.prepare(
        `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`
      ).run(id(), email, confirmToken, token(24), now());
    }

    const link = `${config.apiUrl}/api/newsletter/confirm?token=${confirmToken}`;
    sendMail(
      email,
      'Confirm your YnR subscription',
      `Tap to confirm you want to hear when a new one-of-one piece drops:\n\n${link}\n\n` +
      `If you did not request this, ignore this email and nothing happens.`
    );

    res.json({ ok: true, message: 'Almost there. Check your email to confirm.' });
  })
);

router.get('/newsletter/confirm', wrap((req, res) => {
  const t = String(req.query.token || '');
  const row = t && db.prepare('SELECT * FROM subscribers WHERE confirm_token = ?').get(t);
  if (!row) return res.status(400).send(page('Link expired', 'That confirmation link is no longer valid.'));

  db.prepare("UPDATE subscribers SET status='confirmed', confirmed_at=?, confirm_token=NULL WHERE id=?")
    .run(now(), row.id);
  res.send(page('You are on the list', 'We will let you know the moment a new piece goes up.'));
}));

router.get('/newsletter/unsubscribe', wrap((req, res) => {
  const t = String(req.query.token || '');
  const row = t && db.prepare('SELECT * FROM subscribers WHERE unsub_token = ?').get(t);
  if (!row) return res.status(400).send(page('Not found', 'That unsubscribe link is not valid.'));
  db.prepare("UPDATE subscribers SET status='unsubscribed' WHERE id=?").run(row.id);
  res.send(page('Unsubscribed', 'You will not hear from us again.'));
}));

// ---------------------------------------------------------------------------
// Repaint requests for pieces that have already sold
// ---------------------------------------------------------------------------
router.post('/repaint',
  rateLimit({ key: 'repaint', windowMs: 10 * 60_000, max: 5 }),
  honeypot(),
  wrap((req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE slug = ?').get(clean(req.body.slug, 90));
    if (!p) throw notFound('That piece does not exist.');

    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 200);
    if (!name) throw bad('Please tell us your name.', 'name_required');
    if (!isEmail(email)) throw bad('That email address does not look right.', 'email_invalid');

    db.prepare(
      `INSERT INTO repaint_requests (id, product_id, name, email, phone, size, note, handled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(id(), p.id, name, email, clean(req.body.phone, 40),
          clean(req.body.size, 12), clean(req.body.note, 1000), now());

    notifyOwner(`Repaint request: ${p.name}`, `${name} <${email}> wants ${p.name} repainted.`);
    res.json({ ok: true, message: 'Request received. We will be in touch about a repaint.' });
  })
);

// Minimal styled page for the email-link landings.
function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — YnR</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#f2efe9;
      font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
 .c{max-width:460px;text-align:center}
 h1{font-size:30px;margin:0 0 12px;letter-spacing:-.01em}
 p{color:#8f8b84;margin:0 0 22px}
 a{color:#f2efe9;border:1px solid rgba(242,239,233,.3);padding:11px 20px;
   text-decoration:none;display:inline-block;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
 a:hover{background:#7c1015;border-color:#7c1015}
</style>
<div class="c"><h1>${title}</h1><p>${body}</p><a href="${config.siteUrl}">Back to the shop</a></div>`;
}

module.exports = router;
