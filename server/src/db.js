'use strict';
const fs = require('fs');
const config = require('./config');

fs.mkdirSync(config.paths.uploads, { recursive: true });

/**
 * pg-mem is a pure-JS Postgres-compatible engine used ONLY by the test suite
 * (test/smoke.js sets PG_DRIVER=pg-mem on the child process it spawns), so
 * the whole app can be exercised end to end with no real database reachable.
 * It is never selected outside that harness: production requires DATABASE_URL
 * and config.js refuses to boot in production without one.
 */
const usingMemory = process.env.PG_DRIVER === 'pg-mem';

/**
 * By default node-postgres returns BIGINT/NUMERIC columns as strings, since a
 * BIGINT can exceed JS's safe integer range and the driver will not silently
 * lose precision. Every timestamp and kobo amount in this schema is BIGINT
 * (see below), and this app's own values never approach that range, so
 * returning them as JS numbers is safe here and avoids "1788444859938" < 123
 * doing string comparison instead of the numeric one the code expects.
 * Registered globally, before any Pool exists, so it also applies to pg-mem
 * in tests — confirmed empirically, not assumed.
 */
const { types } = require('pg');
types.setTypeParser(20, Number);   // BIGINT / int8
types.setTypeParser(1700, Number); // NUMERIC

let Pool;
if (usingMemory) {
  ({ Pool } = require('pg-mem').newDb({ autoCreateForeignKeyIndices: true }).adapters.createPg());
} else {
  ({ Pool } = require('pg'));
}

if (!usingMemory && !config.db.url) {
  throw new Error(
    'DATABASE_URL is not set. Point it at your Postgres connection string ' +
    '(on Neon: the project dashboard\'s "Connection string" panel).'
  );
}

const pool = usingMemory
  ? new Pool()
  : new Pool({
      connectionString: config.db.url,
      // Hosted Postgres (Neon included) requires TLS, and its certificate
      // chain is not always in Node's default trust store, so this follows
      // the commonly documented node-postgres example rather than a
      // stricter check that would refuse to connect at all.
      ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
      max: config.db.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

pool.on('error', (err) => {
  // A background/idle client dying must not crash the whole process.
  console.error('[db] unexpected error on an idle client:', err.message);
});

/* ---------------------------------------------------------------------------
 * Query helpers
 *
 * These mirror the shape of the previous synchronous SQLite API (get/all/run)
 * so route logic barely changes: mainly `await` added at each call site. The
 * one real difference is that every call is now async, over a network
 * connection, which is also why transactions need explicit handling below.
 * ------------------------------------------------------------------------- */

/** SQLite used `?` placeholders; Postgres needs positional `$1, $2, ...`. */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function all(sql, params = []) {
  const r = await pool.query(toPg(sql), params);
  return r.rows;
}

async function get(sql, params = []) {
  const r = await pool.query(toPg(sql), params);
  return r.rows[0];
}

async function run(sql, params = []) {
  const r = await pool.query(toPg(sql), params);
  return { changes: r.rowCount, rows: r.rows };
}

/**
 * Runs `fn` against a single dedicated connection wrapped in BEGIN/COMMIT,
 * rolling back automatically if `fn` throws. A transaction MUST stay on one
 * connection: querying through the shared pool instead would let Postgres
 * hand different statements to different connections, breaking atomicity
 * silently. This is exactly where the one-of-one hold logic depends on
 * getting this right — see services/index.js and routes/orders.js.
 */
async function transaction(fn) {
  const client = await pool.connect();
  const tx = {
    all: async (sql, params = []) => (await client.query(toPg(sql), params)).rows,
    get: async (sql, params = []) => (await client.query(toPg(sql), params)).rows[0],
    run: async (sql, params = []) => {
      const r = await client.query(toPg(sql), params);
      return { changes: r.rowCount, rows: r.rows };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback itself failed:', rollbackErr.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

const now = () => Date.now();

/* ---------------------------------------------------------------------------
 * Schema
 *
 * Money is kobo, timestamps are milliseconds since epoch: both as BIGINT.
 * Postgres's plain INTEGER is 32-bit (max ~2.1 billion) and Date.now() is
 * already around 1.79 trillion, so INTEGER here would silently overflow.
 * Small bounded flags (booleans-as-0/1, sort order) stay INTEGER.
 *
 * product_images and order_items add an explicit `seq` column: SQLite's
 * queries relied on its implicit rowid for insertion order, which Postgres
 * has no equivalent of.
 *
 * CREATE TABLE IF NOT EXISTS only creates a table that does not exist yet —
 * it does not add a column to one that already does. That is harmless while
 * no real deployment exists (every test run starts from an empty pg-mem
 * database, so this always runs against a fresh schema); the moment the real
 * Postgres database has live rows in it, a column added here needs a real
 * `ALTER TABLE ... ADD COLUMN` migration alongside it, not just an edit to
 * this string.
 * ------------------------------------------------------------------------- */
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
  price_kobo    BIGINT NOT NULL CHECK (price_kobo >= 0),
  description   TEXT NOT NULL DEFAULT '',
  sizes_json    TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'available',
  held_until    BIGINT,
  held_by       TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_held   ON products(held_until);

CREATE TABLE IF NOT EXISTS product_images (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  alt         TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  seq         BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS delivery_zones (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  fee_kobo   BIGINT,           -- NULL means "quoted manually on WhatsApp"
  note       TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  reference          TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'draft',
  channel            TEXT NOT NULL DEFAULT 'whatsapp',
  customer_name      TEXT NOT NULL DEFAULT '',
  customer_email     TEXT NOT NULL DEFAULT '',
  customer_phone     TEXT NOT NULL DEFAULT '',
  address_line       TEXT NOT NULL DEFAULT '',
  city               TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL DEFAULT '',
  country            TEXT NOT NULL DEFAULT 'Nigeria',
  zone_code          TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  subtotal_kobo      BIGINT NOT NULL DEFAULT 0,
  delivery_kobo      BIGINT NOT NULL DEFAULT 0,
  total_kobo         BIGINT NOT NULL DEFAULT 0,
  payment_status     TEXT NOT NULL DEFAULT 'unpaid',
  paystack_reference TEXT,
  paid_at            BIGINT,
  amount_paid_kobo   BIGINT,
  tracking_ref       TEXT NOT NULL DEFAULT '',
  refund_id          TEXT,
  refund_status      TEXT,       -- pending | processing | processed | failed | needs-attention
  refunded_kobo      BIGINT,
  refund_requested_at BIGINT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_pref    ON orders(paystack_reference);

CREATE TABLE IF NOT EXISTS order_items (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id     TEXT REFERENCES products(id),
  name_snapshot  TEXT NOT NULL,
  size           TEXT NOT NULL DEFAULT '',
  price_kobo     BIGINT NOT NULL,
  image_snapshot TEXT NOT NULL DEFAULT '',
  seq            BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'paystack',
  event        TEXT NOT NULL,
  reference    TEXT,
  signature_ok INTEGER NOT NULL DEFAULT 0,
  processed    INTEGER NOT NULL DEFAULT 0,
  result       TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL,
  created_at   BIGINT NOT NULL
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
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending',
  confirm_token TEXT,
  unsub_token   TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  confirmed_at  BIGINT
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
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  admin_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_outbox (
  id         TEXT PRIMARY KEY,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  error      TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

-- First-party analytics: no third-party account, no personal data, just
-- enough to answer "what gets looked at" and "does anyone click through to
-- WhatsApp" — the two questions actually asked for. No IP or user-agent
-- column on purpose: this shop does not need per-visitor tracking to answer
-- either question, and not collecting it is one less thing NDPA compliance
-- has to account for.
CREATE TABLE IF NOT EXISTS analytics_events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,   -- page_view | product_view | whatsapp_click
  path       TEXT NOT NULL DEFAULT '',
  slug       TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_type_time ON analytics_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_slug ON analytics_events(slug);
`;

/**
 * Runs the schema one statement at a time rather than as one multi-statement
 * string. Real Postgres accepts either, but pg-mem's simple-query handling
 * of a batch of several CREATE TABLE statements in a single call breaks on
 * some constraint combinations (confirmed directly against this schema, not
 * assumed) — and executing statements individually is the more portable,
 * standard way to run DDL regardless, so this is not a test-only workaround.
 *
 * Memoized per process. It is called once at server boot (index.js), and
 * again defensively at the top of seed.js and create-admin.js so either can
 * run standalone against a bare database — this makes those redundant calls
 * a genuine no-op instead of re-running DDL. That distinction matters beyond
 * tidiness: real Postgres treats CREATE TABLE IF NOT EXISTS as idempotent
 * even across separate connections, but pg-mem (used only by the test
 * harness) does not — confirmed directly, it throws on the second pass. This
 * guard is what makes the test harness behave the way real Postgres already
 * does, rather than a workaround for something that would also happen with
 * real Postgres in production.
 */
let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = (async () => {
      const statements = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        await pool.query(stmt);
      }
    })();
  }
  return migrated;
}

module.exports = { pool, all, get, run, transaction, migrate, now };
