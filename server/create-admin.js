'use strict';
// Creates or updates the admin account.
//   node create-admin.js you@example.com                 (generates a password)
//   node create-admin.js you@example.com "your-password"
const crypto = require('crypto');
const db = require('./src/db');
const { id, hashPassword, isEmail } = require('./src/lib/util');

async function main() {
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

  await db.migrate();

  const { hash, salt } = hashPassword(password);
  const existing = await db.get('SELECT * FROM admin_users WHERE email=?', [email]);

  if (existing) {
    await db.run('UPDATE admin_users SET password_hash=?, password_salt=? WHERE id=?',
      [hash, salt, existing.id]);
    // Force a fresh sign-in everywhere after a password change.
    await db.run('DELETE FROM sessions WHERE admin_id=?', [existing.id]);
    console.log(`\n  Password updated for ${email}`);
  } else {
    await db.run('INSERT INTO admin_users (id, email, password_hash, password_salt, created_at) VALUES (?,?,?,?,?)',
      [id(), email, hash, salt, db.now()]);
    console.log(`\n  Admin created: ${email}`);
  }

  if (generated) {
    console.log(`  Password:      ${password}`);
    console.log('\n  Copy it now, it is not stored anywhere in readable form.');
  }
  console.log('\n  Sign in at /admin\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
