'use strict';
// Creates or updates the admin account.
//   node create-admin.js you@example.com                 (generates a password)
//   node create-admin.js you@example.com "your-password"
const crypto = require('crypto');
const { db, now } = require('./src/db');
const { id, hashPassword, isEmail } = require('./src/lib/util');

const email = String(process.argv[2] || '').trim().toLowerCase();
let password = process.argv[3];

if (!isEmail(email)) {
  console.error('\nUsage: node create-admin.js <email> [password]\n');
  process.exit(1);
}

let generated = false;
if (!password) {
  // Ambiguity-free alphabet: no O/0, I/l/1.
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  password = Array.from(bytes, (b) => alpha[b % alpha.length]).join('');
  generated = true;
} else if (password.length < 10) {
  console.error('\nPassword must be at least 10 characters.\n');
  process.exit(1);
}

const { hash, salt } = hashPassword(password);
const existing = db.prepare('SELECT * FROM admin_users WHERE email=?').get(email);

if (existing) {
  db.prepare('UPDATE admin_users SET password_hash=?, password_salt=? WHERE id=?')
    .run(hash, salt, existing.id);
  // Force a fresh sign-in everywhere after a password change.
  db.prepare('DELETE FROM sessions WHERE admin_id=?').run(existing.id);
  console.log(`\n  Password updated for ${email}`);
} else {
  db.prepare('INSERT INTO admin_users (id, email, password_hash, password_salt, created_at) VALUES (?,?,?,?,?)')
    .run(id(), email, hash, salt, now());
  console.log(`\n  Admin created: ${email}`);
}

if (generated) {
  console.log(`  Password:      ${password}`);
  console.log('\n  Copy it now, it is not stored anywhere in readable form.');
}
console.log('\n  Sign in at /admin\n');
