'use strict';
// Runs the whole shop locally — storefront, API and admin panel — on an
// in-memory database with mock payments and no outgoing email. Nothing to
// configure, and nothing real is touched. http://localhost:4000
//   npm run demo
// Admin: demo@ynr.local / demo-password (unless ADMIN_EMAIL/ADMIN_PASSWORD are set).
const path = require('path');
const { spawn } = require('child_process');

const port = process.env.PORT || '4000';
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PG_DRIVER: 'pg-mem',
  AUTO_SEED: '1',
  PAYSTACK_MODE: 'mock',
  SMTP_URL: '', // set explicitly so a real one in .env is never picked up
  PORT: port,
  SITE_URL: `http://localhost:${port}`,
  API_URL: `http://localhost:${port}`,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'demo@ynr.local',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'demo-password',
};

const child = spawn(process.execPath, ['--no-warnings', 'src/index.js'],
  { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code == null ? 0 : code));
