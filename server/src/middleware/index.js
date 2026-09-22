'use strict';
const db = require('../db');
const config = require('../config');
const { sha256 } = require('../lib/util');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}
const bad = (msg, code) => new HttpError(400, msg, code || 'bad_request');
const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
const conflict = (msg, code) => new HttpError(409, msg, code || 'conflict');

function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, err);
  }
  // HttpError is always thrown deliberately, with a message already written
  // to be shown to the customer (e.g. "Card payment is not switched on yet.
  // Please check out on WhatsApp.") — that's true regardless of its status
  // code, including the 5xx ones like 503 "not configured". Masking is only
  // for a genuinely unexpected exception, where err.message could be a raw
  // driver/internal error never meant for a customer to see.
  const safeToShow = err instanceof HttpError || status < 500 || !config.isProd;
  res.status(status).json({
    ok: false,
    error: safeToShow ? err.message : 'Something went wrong',
    code: err.code || 'error',
  });
}

// Wrap async handlers so a rejected promise reaches errorHandler
// instead of hanging the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Rate limiting (in-memory sliding window, keyed by IP + bucket)
// ---------------------------------------------------------------------------
const buckets = new Map();
function rateLimit({ windowMs = 60_000, max = 30, key = 'default' } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const k = key + ':' + ip;
    const t = Date.now();
    let hits = buckets.get(k) || [];
    hits = hits.filter((ts) => t - ts < windowMs);
    if (hits.length >= max) {
      res.set('Retry-After', Math.ceil(windowMs / 1000));
      return next(new HttpError(429, 'Too many requests, please slow down.', 'rate_limited'));
    }
    hits.push(t);
    buckets.set(k, hits);
    next();
  };
}
// Keep the map from growing without bound on a long-running process.
setInterval(() => {
  const t = Date.now();
  for (const [k, hits] of buckets) {
    const keep = hits.filter((ts) => t - ts < 600_000);
    if (keep.length) buckets.set(k, keep);
    else buckets.delete(k);
  }
}, 300_000).unref();

// ---------------------------------------------------------------------------
// Honeypot: bots fill hidden fields that humans never see.
// ---------------------------------------------------------------------------
function honeypot(field = 'website') {
  return (req, res, next) => {
    if (req.body && req.body[field]) {
      // Respond as if it worked so the bot does not learn to adapt.
      return res.json({ ok: true });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Admin auth (opaque token in an httpOnly cookie, hashed at rest)
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function currentAdmin(req) {
  const raw = parseCookies(req)[config.session.cookie];
  if (!raw) return null;
  const row = await db.get(
    `SELECT s.admin_id, s.expires_at, a.email
       FROM sessions s JOIN admin_users a ON a.id = s.admin_id
      WHERE s.token_hash = ?`,
    [sha256(raw)]
  );
  if (!row) return null;
  if (Number(row.expires_at) < db.now()) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(raw)]);
    return null;
  }
  return { id: row.admin_id, email: row.email };
}

// Express 4 does not catch a rejected promise from an async middleware on its
// own (that lands in Express 5), so this catches it explicitly, the same way
// wrap() does for route handlers.
function requireAdmin(req, res, next) {
  currentAdmin(req)
    .then((admin) => {
      if (!admin) return next(new HttpError(401, 'Sign in required', 'unauthenticated'));
      req.admin = admin;
      next();
    })
    .catch(next);
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProd) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// CORS limited to the storefront origin.
function cors(req, res, next) {
  const allowed = new Set([config.siteUrl, 'http://localhost:3020', 'http://127.0.0.1:3020']);
  const origin = req.headers.origin;
  if (origin && allowed.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = {
  HttpError, bad, notFound, conflict, errorHandler, wrap,
  rateLimit, honeypot, requireAdmin, currentAdmin, parseCookies,
  securityHeaders, cors,
};
