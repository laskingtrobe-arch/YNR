'use strict';
const crypto = require('crypto');

const id = () => crypto.randomUUID();

// Order references are read aloud on WhatsApp calls, so avoid characters that
// sound or look alike (0/O, 1/I/L, 5/S, 8/B).
const REF_ALPHABET = '23456789ACDEFGHJKMNPQRTUVWXYZ';
function orderRef() {
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return 'YNR-' + s;
}

const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// scrypt keeps password hashing dependency-free. bcrypt/argon2 would both
// pull in a native module for no meaningful gain at this scale.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return timingSafeEqual(candidate, hash);
}

// ---- money -----------------------------------------------------------------
// Everything internal is kobo (integer). Naira only exists for display.
const toKobo = (naira) => Math.round(Number(naira) * 100);
const toNaira = (kobo) => Math.round(Number(kobo)) / 100;
function formatNaira(kobo) {
  const n = toNaira(kobo);
  return '₦' + n.toLocaleString('en-NG', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const clean = (s, max = 2000) => String(s == null ? '' : s).trim().slice(0, max);

module.exports = {
  id, orderRef, token, sha256, timingSafeEqual,
  hashPassword, verifyPassword,
  toKobo, toNaira, formatNaira,
  isEmail, slugify, clean,
};
