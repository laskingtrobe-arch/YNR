'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { db } = require('./db');
const {
  errorHandler, securityHeaders, cors, parseCookies, HttpError,
} = require('./middleware');
const { startHoldSweeper } = require('./services');

const publicRoutes = require('./routes/public');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(cors);

// ---------------------------------------------------------------------------
// Paystack webhook.
//
// Mounted FIRST, with express.raw(), because the signature is an HMAC over the
// exact bytes Paystack sent. If express.json() parsed it first, re-serialising
// would change those bytes and every signature check would fail.
// ---------------------------------------------------------------------------
app.post(
  '/api/payments/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  paymentRoutes.webhookHandler
);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.use((req, res, next) => { req.cookies = parseCookies(req); next(); });

// Uploaded product photography.
app.use('/uploads', express.static(config.paths.uploads, {
  maxAge: '30d',
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
}));

// Admin UI.
app.use('/admin', express.static(path.join(config.paths.root, 'public', 'admin')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: config.env,
    paystack: config.paystack.mock
      ? 'mock'
      : (config.paystack.secretKey ? 'live-key-present' : 'unconfigured'),
    mail: config.mail.smtpUrl ? 'smtp' : 'outbox-only',
    holdMinutes: config.holdMinutes,
    time: Date.now(),
  });
});

app.use('/api', publicRoutes);
app.use('/api', orderRoutes);
app.use('/api', paymentRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (req, res, next) => next(new HttpError(404, 'No such endpoint.', 'not_found')));

// ---------------------------------------------------------------------------
// The storefront.
//
// Serving it from here means the whole shop is one deployment on one origin:
// no CORS, no second host, and the browser's /api calls land on this server.
// Skipped when the folder is absent, so the API can still be deployed alone
// with the storefront hosted separately (on Vercel, say).
// ---------------------------------------------------------------------------
const hasStorefront = fs.existsSync(path.join(config.paths.storefront, 'index.html'));
if (hasStorefront) {
  app.use(express.static(config.paths.storefront, { extensions: ['html'] }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(config.paths.storefront, 'index.html'));
  });
}

app.use(errorHandler);

/**
 * First-boot setup for hosted deployments, where there may be no shell to run
 * the setup scripts from. Both steps are skipped once they have happened, so
 * this is safe to run on every restart.
 */
function bootstrap() {
  if (config.bootstrap.autoSeed) {
    const count = db.prepare('SELECT COUNT(*) AS v FROM products').get().v;
    if (!count) {
      try {
        require('../seed.js');
        console.log('  Seeded the starting catalogue (AUTO_SEED).');
      } catch (e) {
        console.error('  ! AUTO_SEED failed:', e.message);
      }
    }
  }

  const admins = db.prepare('SELECT COUNT(*) AS v FROM admin_users').get().v;
  if (!admins && config.bootstrap.adminEmail && config.bootstrap.adminPassword) {
    const { id, hashPassword } = require('./lib/util');
    const { hash, salt } = hashPassword(config.bootstrap.adminPassword);
    db.prepare(
      'INSERT INTO admin_users (id, email, password_hash, password_salt, created_at) VALUES (?,?,?,?,?)'
    ).run(id(), config.bootstrap.adminEmail.toLowerCase(), hash, salt, Date.now());
    console.log(`  Created admin ${config.bootstrap.adminEmail} from ADMIN_EMAIL/ADMIN_PASSWORD.`);
    console.warn('  ! Change that password, then clear ADMIN_PASSWORD from the environment.');
  } else if (!admins) {
    console.warn('\n  ! No admin user yet. Create one with:  npm run create-admin <email>');
    console.warn('    Or set ADMIN_EMAIL and ADMIN_PASSWORD and restart.\n');
  }

  const products = db.prepare('SELECT COUNT(*) AS v FROM products').get().v;
  if (!products) {
    console.warn('  ! The catalogue is empty. Run:  npm run seed   (or set AUTO_SEED=1)');
  }
}

if (require.main === module) {
  bootstrap();
  startHoldSweeper();
  app.listen(config.port, () => {
    console.log(`\n  YnR API   http://localhost:${config.port}`);
    console.log(`  Shop      ${hasStorefront ? `http://localhost:${config.port}/` : 'served separately (storefront/ not found)'}`);
    console.log(`  Admin     http://localhost:${config.port}/admin`);
    console.log(`  Health    http://localhost:${config.port}/api/health`);
    console.log(`  Payments  ${config.paystack.mock ? 'MOCK MODE (no real money)' : (config.paystack.secretKey ? 'Paystack key present' : 'not configured')}`);
    console.log(`  Holds     ${config.holdMinutes} minutes\n`);
  });
}

module.exports = app;
