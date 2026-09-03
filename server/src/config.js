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
    data: path.join(ROOT, 'data'),
    uploads: path.join(ROOT, 'uploads'),
    db: process.env.DB_PATH || path.join(ROOT, 'data', 'ynr.db'),
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
  const missing = [];
  if (!config.paystack.secretKey) missing.push('PAYSTACK_SECRET_KEY');
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (missing.length) {
    // Fail loudly rather than booting a production server that cannot take money.
    throw new Error('Missing required production env vars: ' + missing.join(', '));
  }
}

module.exports = config;
