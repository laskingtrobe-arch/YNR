'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.paths.data, { recursive: true });
fs.mkdirSync(config.paths.uploads, { recursive: true });

const db = new DatabaseSync(config.paths.db);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

// ---------------------------------------------------------------------------
// Schema
//
// Money is stored in kobo as an INTEGER everywhere. Never floats: 0.1 + 0.2
// problems in a currency column turn into real accounting errors.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category_id   TEXT REFERENCES categories(id),
  price_kobo    INTEGER NOT NULL CHECK (price_kobo >= 0),
  description   TEXT NOT NULL DEFAULT '',
  sizes_json    TEXT NOT NULL DEFAULT '[]',
  -- available | held | sold | repaint_only
  status        TEXT NOT NULL DEFAULT 'available',
  held_until    INTEGER,
  held_by       TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_held   ON products(held_until);

CREATE TABLE IF NOT EXISTS product_images (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  alt         TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS delivery_zones (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  fee_kobo   INTEGER,          -- NULL means "quoted manually on WhatsApp"
  note       TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'draft',
  channel           TEXT NOT NULL DEFAULT 'whatsapp',   -- whatsapp | paystack
  customer_name     TEXT NOT NULL DEFAULT '',
  customer_email    TEXT NOT NULL DEFAULT '',
  customer_phone    TEXT NOT NULL DEFAULT '',
  address_line      TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT 'Nigeria',
  zone_code         TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  subtotal_kobo     INTEGER NOT NULL DEFAULT 0,
  delivery_kobo     INTEGER NOT NULL DEFAULT 0,
  total_kobo        INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'unpaid',     -- unpaid | pending | paid | refunded
  paystack_reference TEXT,
  paid_at           INTEGER,
  amount_paid_kobo  INTEGER,
  tracking_ref      TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_pref    ON orders(paystack_reference);

-- Line items carry a frozen copy of name/size/price. If a product's price
-- changes later, historic orders must not silently change with it.
CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    TEXT REFERENCES products(id),
  name_snapshot TEXT NOT NULL,
  size          TEXT NOT NULL DEFAULT '',
  price_kobo    INTEGER NOT NULL,
  image_snapshot TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- Raw webhook events, kept for idempotency and for dispute evidence.
CREATE TABLE IF NOT EXISTS payment_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'paystack',
  event        TEXT NOT NULL,
  reference    TEXT,
  signature_ok INTEGER NOT NULL DEFAULT 0,
  processed    INTEGER NOT NULL DEFAULT 0,
  result       TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pevents_dedupe
  ON payment_events(provider, event, reference);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  subject    TEXT NOT NULL,
  message    TEXT NOT NULL,
  handled    INTEGER NOT NULL DEFAULT 0,
  ip         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | unsubscribed
  confirm_token TEXT,
  unsub_token   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  confirmed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS repaint_requests (
  id         TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id),
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  size       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  handled    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  admin_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Outbox so that mail is never silently dropped when SMTP is unconfigured.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id         TEXT PRIMARY KEY,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  error      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

db.exec(SCHEMA);

const now = () => Date.now();

module.exports = { db, now };
