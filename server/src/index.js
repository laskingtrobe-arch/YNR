'use strict';
const express = require('express');
const path = require('path');
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
app.use(errorHandler);

if (require.main === module) {
  const admins = db.prepare('SELECT COUNT(*) AS v FROM admin_users').get().v;
  if (!admins) {
    console.warn('\n  ! No admin user yet. Create one with:  npm run create-admin\n');
  }
  startHoldSweeper();
  app.listen(config.port, () => {
    console.log(`\n  YnR API   http://localhost:${config.port}`);
    console.log(`  Admin     http://localhost:${config.port}/admin`);
    console.log(`  Health    http://localhost:${config.port}/api/health`);
    console.log(`  Payments  ${config.paystack.mock ? 'MOCK MODE (no real money)' : (config.paystack.secretKey ? 'Paystack key present' : 'not configured')}`);
    console.log(`  Holds     ${config.holdMinutes} minutes\n`);
  });
}

module.exports = app;
