'use strict';
const path = require('path');
const fs = require('fs');

// Load .env if present (no dependency needed for a file this simple).
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

const ROOT = path.join(__dirname, '..');
const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

const config = {
  env,
  isProd,
  port: parseInt(process.env.PORT || '4000', 10),

  // Where the storefront is served from, used for CORS and redirect targets.
  siteUrl: process.env.SITE_URL || 'http://localhost:3020',
  apiUrl: process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`,

  paths: {
    root: ROOT,
    data: process.env.DATA_DIR || path.join(ROOT, 'data'),
    // On a hosted platform these two point at a mounted disk, so the database
    // and the product photos survive restarts and redeploys.
    uploads: process.env.UPLOADS_DIR || path.join(ROOT, 'uploads'),
    db: process.env.DB_PATH
      || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'ynr.db'),
    // The storefront, served by this server when it is deployed as one app.
    storefront: process.env.STOREFRONT_DIR || path.join(ROOT, '..', 'storefront'),
  },

  // Create the first admin on boot when none exists. Lets the shop be set up
  // on a platform with no shell access.
  bootstrap: {
    adminEmail: process.env.ADMIN_EMAIL || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    autoSeed: /^(1|true|yes)$/i.test(process.env.AUTO_SEED || ''),
  },

  session: {
    cookie: 'ynr_admin',
    ttlHours: parseInt(process.env.SESSION_TTL_HOURS || '12', 10),
  },

  // How long a one-of-one piece stays reserved while a customer checks out.
  holdMinutes: parseInt(process.env.HOLD_MINUTES || '30', 10),

  whatsappNumber: process.env.WHATSAPP_NUMBER || '2349026947815',

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    // Mock mode lets the whole checkout flow be exercised without live keys.
    // Hard-blocked in production so it can never ship by accident.
    mock: (process.env.PAYSTACK_MODE || '').toLowerCase() === 'mock' && !isProd,
    base: 'https://api.paystack.co',
  },

  mail: {
    from: process.env.MAIL_FROM || 'YnR <orders@ynr.local>',
    ownerTo: process.env.OWNER_EMAIL || 'owner@ynr.local',
    // When no SMTP transport is configured, mail is written to the outbox
    // table and logged, so nothing is silently lost during development.
    smtpUrl: process.env.SMTP_URL || '',
  },

  uploads: {
    maxBytes: parseInt(process.env.UPLOAD_MAX_BYTES || String(6 * 1024 * 1024), 10),
    allowed: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  },
};

if (config.isProd) {
  // Only genuinely unsafe gaps stop the boot. Sessions are signed with this,
  // so without it admin logins would be forgeable.
  if (!process.env.SESSION_SECRET) {
    throw new Error(
      'SESSION_SECRET must be set in production. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  // Paystack is deliberately not required. Merchant approval takes weeks in
  // Nigeria, and the shop should be able to launch on WhatsApp-confirmed
  // orders before then. The payment routes return a clear 503 until it is set.
  if (!config.paystack.secretKey) {
    console.warn(
      '[config] No PAYSTACK_SECRET_KEY. Card payment is switched off; ' +
      'customers can still order and confirm on WhatsApp.'
    );
  }
}

module.exports = config;
