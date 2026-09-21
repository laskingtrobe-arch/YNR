'use strict';
// Seeds the catalogue from the six pieces originally hardcoded in the
// storefront, plus the delivery tiers from its Delivery table.
//
// Exports an async run() so it can be awaited from index.js on first boot
// (AUTO_SEED=1) as well as invoked directly via `npm run seed`.
const fs = require('fs');
const path = require('path');
const db = require('./src/db');
const config = require('./src/config');
const { id, toKobo } = require('./src/lib/util');

const SRC_IMAGES = path.join(config.paths.root, '..', 'storefront', 'assets', 'products');

const CATEGORIES = [
  { slug: 'hoodies', name: 'Hoodies', sort: 1 },
  { slug: 'tees', name: 'Tees', sort: 2 },
  { slug: 'long-sleeves', name: 'Long Sleeves', sort: 3 },
  { slug: 'denim', name: 'Denim', sort: 4 },
];

// Order here matches SHOP_ORDER in the storefront.
const PRODUCTS = [
  {
    slug: 'ynr-icon-hoodie', name: 'YnR Icon Hoodie', category: 'hoodies', price: 75000,
    file: 'product-2-ynr-icon-hoodie.jpg', sizes: ['M', 'L', 'XL', 'XXL'],
    description: 'Heather grey oversized hoodie with the YnR circular emblem on the chest and contrast dark cuffs. Heavyweight fleece built for layering — the everyday piece with the YnR mark front and centre.',
  },
  {
    slug: 'out-of-this-world', name: 'Out Of This World Tee', category: 'tees', price: 49999,
    file: 'product-1-out-of-this-world-tee.jpg', sizes: ['S', 'M', 'L', 'XL'],
    description: 'Navy oversized tee, hand-painted end to end — a UFO beaming down over a lone figure, with "Out Of This World" hand-lettered in ice-blue across the chest. No two brush strokes are the same, so this exact piece exists once.',
  },
  {
    slug: 'aliens-are-coming', name: 'Aliens Are Coming Long Sleeve', category: 'long-sleeves', price: 59999,
    file: 'product-4-aliens-are-coming-longsleeve.jpg', sizes: ['M', 'L', 'XL'],
    description: 'Charcoal layered-sleeve long sleeve with a distressed finish and a hand-signed "Young and Reckless" tag. Bold green "The Aliens Are Coming" graphic across the chest, finished with a small hand-drawn alien detail.',
  },
  {
    slug: 'alien-invasion', name: 'Alien Invasion Tee', category: 'tees', price: 49999,
    file: 'product-3-alien-invasion-tee.jpg', sizes: ['S', 'M', 'L', 'XL'],
    description: 'White oversized tee with a full-chest "Alien Invasion" graphic — chaos, awakening, and a new world order, hand-detailed over a printed base. Every piece gets its own hand-finishing pass before it leaves the shop.',
  },
  {
    slug: 'reckless-yute', name: 'Reckless Yute Limited Edition Tee', category: 'tees', price: 49999,
    file: 'product-5-reckless-yute-tee.jpg', sizes: ['S', 'M', 'L', 'XL'],
    description: 'Black oversized tee, custom "Reckless Yute" wordmark in red and white with an original character illustration across the chest. One of the more requested pieces — once it\'s gone, we repaint the next.',
  },
  {
    slug: 'young-reckless-jeans', name: 'Young Reckless Hand-Painted Jeans', category: 'denim', price: 35000,
    file: 'product-6-young-reckless-jeans.jpg', sizes: ['30', '32', '34', '36'],
    description: 'Dark wash denim, hand-painted front and back with a falling angel figure and "Young Reckless" hand-lettered across the thigh. Every pair is painted individually, so the exact placement is never identical twice.',
  },
];

// Mirrors the storefront's Delivery table. A NULL fee means the price is
// quoted by a human on WhatsApp, which is how YnR actually works.
const ZONES = [
  { code: 'abuja', label: 'Within Abuja', fee: 2000, note: 'Flat rate, delivered directly', sort: 1 },
  { code: 'nigeria', label: 'Outside Abuja (within Nigeria)', fee: null, note: 'Confirmed with you on WhatsApp before you pay', sort: 2 },
  { code: 'international', label: 'International', fee: null, note: 'Shipped via courier partner, cost confirmed on WhatsApp', sort: 3 },
];

async function upsertCategory(c) {
  const existing = await db.get('SELECT * FROM categories WHERE slug=?', [c.slug]);
  if (existing) return existing.id;
  const cid = id();
  await db.run('INSERT INTO categories (id, slug, name, sort) VALUES (?,?,?,?)', [cid, c.slug, c.name, c.sort]);
  return cid;
}

function copyImage(file) {
  const from = path.join(SRC_IMAGES, file);
  if (!fs.existsSync(from)) {
    console.warn(`  ! image missing, skipping: ${file}`);
    return null;
  }
  const to = path.join(config.paths.uploads, file);
  if (!fs.existsSync(to)) fs.copyFileSync(from, to);
  return `/uploads/${file}`;
}

async function run() {
  console.log('Seeding YnR catalogue...');
  await db.migrate();

  const catIds = {};
  for (const c of CATEGORIES) catIds[c.slug] = await upsertCategory(c);
  console.log(`  categories: ${CATEGORIES.length}`);

  for (const z of ZONES) {
    const existing = await db.get('SELECT * FROM delivery_zones WHERE code=?', [z.code]);
    if (existing) continue;
    await db.run('INSERT INTO delivery_zones (id, code, label, fee_kobo, note, sort, active) VALUES (?,?,?,?,?,?,1)',
      [id(), z.code, z.label, z.fee == null ? null : toKobo(z.fee), z.note, z.sort]);
  }
  console.log(`  delivery zones: ${ZONES.length}`);

  let added = 0, skipped = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const p = PRODUCTS[i];
    if (await db.get('SELECT 1 FROM products WHERE slug=?', [p.slug])) { skipped++; continue; }
    const pid = id();
    await db.run(`
      INSERT INTO products (id, slug, name, category_id, price_kobo, description, sizes_json,
        status, sort, published, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,'available',?,1,?,?)`,
      [pid, p.slug, p.name, catIds[p.category], toKobo(p.price), p.description,
       JSON.stringify(p.sizes), i, db.now(), db.now()]);

    const url = copyImage(p.file);
    if (url) {
      await db.run('INSERT INTO product_images (id, product_id, url, alt, sort) VALUES (?,?,?,?,0)',
        [id(), pid, url, `${p.name}, hand-painted by YnR`]);
    }
    added++;
  }

  console.log(`  products: ${added} added, ${skipped} already present`);
  console.log('Done.');
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => { console.error('Seed failed:', e); process.exit(1); });
}
