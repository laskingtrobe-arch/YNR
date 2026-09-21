'use strict';
// End-to-end smoke test. Runs a throwaway server against a throwaway database
// so it can be run repeatedly without touching real data.
//
// The database is pg-mem: an in-memory, Postgres-wire-compatible engine that
// lives inside the spawned server process only (see PG_DRIVER below and
// src/db.js). Because it is in-process memory rather than a shared file, it
// cannot be seeded from a separate `node seed.js` child process the way the
// old SQLite version was — that would seed a different, discarded database.
// Instead this drives the server's own first-boot bootstrap (AUTO_SEED,
// ADMIN_EMAIL/ADMIN_PASSWORD in src/index.js), which is also a real exercise
// of the exact path a host with no shell access relies on.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 4999;
const SECRET = 'sk_test_smoke_secret';
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'smoke@ynr.test';
const ADMIN_PASSWORD = 'smoke-password-123';

const ENV = {
  ...process.env,
  NODE_ENV: 'development',
  PG_DRIVER: 'pg-mem',
  AUTO_SEED: '1',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  PORT: String(PORT),
  PAYSTACK_MODE: 'mock',
  PAYSTACK_SECRET_KEY: SECRET,
  API_URL: BASE,
};

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  -> ' + extra : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html page */ }
  return { status: res.status, json, text, headers: res.headers };
}

(async () => {
  console.log('\nYnR back end smoke test\n');

  // Seeding and admin creation happen inside the server's own boot sequence
  // now (AUTO_SEED / ADMIN_EMAIL / ADMIN_PASSWORD in ENV above), not as
  // separate processes — see the note at the top of this file for why.
  //
  // The child's output is captured to a file rather than discarded
  // (stdio: 'ignore' used to be the default here): a startup failure with no
  // stdout/stderr to show for it is undiagnosable, which is exactly the spot
  // a real problem hid the first time this was written.
  const bootLog = path.join(os.tmpdir(), `ynr-smoke-boot-${process.pid}.log`);
  const bootFd = fs.openSync(bootLog, 'w');
  const server = spawn(process.execPath, ['--no-warnings', 'src/index.js'],
    { cwd: ROOT, env: ENV, stdio: ['ignore', bootFd, bootFd] });

  // Wait for the port to answer. 50 x 300ms = 15s: generous for a loaded dev
  // machine or a cold container start, not just the common case.
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) break; // crashed — no point polling further
    try { const h = await req('GET', '/api/health'); if (h.json && h.json.ok) { up = true; break; } }
    catch { /* not listening yet */ }
    await sleep(300);
  }
  if (!up) {
    fs.closeSync(bootFd);
    console.error(`server never came up (exit code: ${server.exitCode})\n--- server output (${bootLog}) ---`);
    console.error(fs.readFileSync(bootLog, 'utf8') || '(empty — nothing was written)');
    server.kill();
    process.exit(1);
  }

  try {
    // ---- catalogue -------------------------------------------------------
    const products = await req('GET', '/api/products');
    ok(products.json.products.length === 6, 'catalogue returns 6 seeded pieces');
    const hoodie = products.json.products.find((p) => p.slug === 'ynr-icon-hoodie');
    ok(hoodie && hoodie.priceKobo === 7500000, 'price stored in kobo (₦75,000 = 7500000)',
      hoodie && String(hoodie.priceKobo));

    const detail = await req('GET', '/api/products/ynr-icon-hoodie');
    ok(detail.json.product.sizes.length === 4, 'product detail carries sizes');
    ok(detail.json.related.length === 3, 'related pieces returned');

    // ---- validation ------------------------------------------------------
    const badEmail = await req('POST', '/api/orders', {
      items: [{ slug: 'ynr-icon-hoodie', size: 'L' }],
      name: 'Test', email: 'not-an-email', phone: '08012345678', zone: 'abuja',
    });
    ok(badEmail.status === 400, 'order with bad email is rejected', String(badEmail.status));

    const emptyBag = await req('POST', '/api/orders', { items: [], name: 'T', email: 'a@b.co', phone: '08012345678' });
    ok(emptyBag.status === 400, 'empty bag is rejected');

    // ---- order creation --------------------------------------------------
    const order = await req('POST', '/api/orders', {
      items: [{ slug: 'ynr-icon-hoodie', size: 'L' }],
      name: 'Ada Test', email: 'ada@example.com', phone: '08012345678',
      addressLine: '12 Test Road', city: 'Abuja', state: 'FCT', zone: 'abuja',
      channel: 'paystack',
    });
    ok(order.status === 201, 'order created', String(order.status) + ' ' + order.text.slice(0, 120));
    const ref = order.json && order.json.order && order.json.order.reference;
    ok(/^YNR-[A-Z0-9]{6}$/.test(ref || ''), 'order reference generated', ref);
    ok(order.json.order.subtotalKobo === 7500000, 'subtotal snapshotted');
    ok(order.json.order.totalKobo === 7500000 + 200000, 'delivery fee added (₦2,000 Abuja)',
      String(order.json.order.totalKobo));
    ok(typeof order.json.whatsappUrl === 'string' && order.json.whatsappUrl.includes(encodeURIComponent(ref)),
      'WhatsApp link carries the order reference');

    // ---- THE ONE-OF-ONE RACE --------------------------------------------
    const second = await req('POST', '/api/orders', {
      items: [{ slug: 'ynr-icon-hoodie', size: 'M' }],
      name: 'Bola Test', email: 'bola@example.com', phone: '08087654321', zone: 'abuja',
    });
    ok(second.status === 409, 'second buyer BLOCKED while piece is held', String(second.status));
    ok(second.json && second.json.code === 'held_by_other', 'block reports held_by_other', second.json && second.json.code);

    // A different piece must still be orderable.
    const other = await req('POST', '/api/orders', {
      items: [{ slug: 'reckless-yute', size: 'M' }],
      name: 'Chidi Test', email: 'chidi@example.com', phone: '08011112222', zone: 'abuja',
    });
    ok(other.status === 201, 'a different piece is still orderable');

    // ---- zone that needs a human quote cannot be paid online -------------
    const intl = await req('POST', '/api/orders', {
      items: [{ slug: 'alien-invasion', size: 'M' }],
      name: 'Zed Test', email: 'zed@example.com', phone: '08033334444',
      zone: 'international', channel: 'paystack',
    });
    ok(intl.status === 400 && intl.json.code === 'zone_needs_quote',
      'online payment blocked when delivery is quoted manually', intl.json && intl.json.code);

    // ---- order lookup ----------------------------------------------------
    const lookup = await req('GET', `/api/orders/${ref}`);
    ok(lookup.status === 200 && lookup.json.order.reference === ref, 'customer can look up order by reference');
    const missing = await req('GET', '/api/orders/YNR-ZZZZZZ');
    ok(missing.status === 404, 'unknown reference returns 404');

    // ---- payment ---------------------------------------------------------
    const init = await req('POST', '/api/payments/init', { reference: ref });
    ok(init.status === 200 && init.json.authorizationUrl, 'payment initialised', init.text.slice(0, 120));
    ok(init.json.amountKobo === 7700000, 'charge amount comes from the DB, not the client',
      String(init.json.amountKobo));

    // ---- webhook signature ----------------------------------------------
    const payload = JSON.stringify({ event: 'charge.success', data: { reference: ref, amount: 7700000, currency: 'NGN', status: 'success' } });

    const unsigned = await req('POST', '/api/payments/webhook', payload, { 'Content-Type': 'application/json' });
    ok(unsigned.status === 401, 'UNSIGNED webhook rejected', String(unsigned.status));

    const wrongSig = crypto.createHmac('sha512', 'wrong-key').update(payload).digest('hex');
    const badPayload = JSON.stringify({ event: 'charge.success', data: { reference: ref, amount: 1, status: 'success' } });
    const forged = await req('POST', '/api/payments/webhook', badPayload,
      { 'x-paystack-signature': wrongSig });
    ok(forged.status === 401, 'webhook with WRONG signature rejected', String(forged.status));

    const goodSig = crypto.createHmac('sha512', SECRET).update(payload).digest('hex');
    const accepted = await req('POST', '/api/payments/webhook', payload,
      { 'x-paystack-signature': goodSig });
    ok(accepted.status === 200, 'correctly signed webhook accepted', String(accepted.status));

    await sleep(600); // webhook fulfils asynchronously after acknowledging

    const afterPay = await req('GET', `/api/orders/${ref}`);
    ok(afterPay.json.order.paymentStatus === 'paid', 'order marked paid via webhook',
      afterPay.json.order.paymentStatus);

    const soldNow = await req('GET', '/api/products/ynr-icon-hoodie');
    ok(soldNow.json.product.isSold === true, 'piece marked SOLD after payment');
    ok(soldNow.json.product.canRepaint === true, 'sold piece offers a repaint');

    // Replay the same webhook: must not double-fulfil.
    const replay = await req('POST', '/api/payments/webhook', payload, { 'x-paystack-signature': goodSig });
    ok(replay.status === 200, 'replayed webhook acknowledged (idempotent)');

    // Ordering a sold piece must now fail.
    const soldOrder = await req('POST', '/api/orders', {
      items: [{ slug: 'ynr-icon-hoodie', size: 'L' }],
      name: 'Late Test', email: 'late@example.com', phone: '08099998888', zone: 'abuja',
    });
    ok(soldOrder.status === 409 && soldOrder.json.code === 'already_sold',
      'sold piece cannot be ordered again', soldOrder.json && soldOrder.json.code);

    // ---- forms that used to throw everything away ------------------------
    const contact = await req('POST', '/api/contact', {
      name: 'Test Person', email: 'test@example.com', subject: 'Sizing', message: 'Is the hoodie true to size?',
    });
    ok(contact.status === 200, 'contact form accepted');

    const news = await req('POST', '/api/newsletter', { email: 'sub@example.com' });
    ok(news.status === 200, 'newsletter signup accepted');
    const dupe = await req('POST', '/api/newsletter', { email: 'sub@example.com' });
    ok(dupe.status === 200, 'repeat newsletter signup handled gracefully');

    const hp = await req('POST', '/api/contact', {
      name: 'Bot', email: 'bot@example.com', subject: 'spam', message: 'buy things', website: 'http://spam',
    });
    ok(hp.status === 200, 'honeypot returns success to the bot');

    // ---- admin auth ------------------------------------------------------
    const noAuth = await req('GET', '/api/admin/products');
    ok(noAuth.status === 401, 'admin API refuses unauthenticated access');

    const badLogin = await req('POST', '/api/admin/login', { email: ADMIN_EMAIL, password: 'wrong' });
    ok(badLogin.status === 401, 'wrong admin password rejected');

    const login = await req('POST', '/api/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    ok(login.status === 200, 'admin login succeeds (bootstrap-created account)');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok(cookie.startsWith('ynr_admin='), 'session cookie issued');
    ok(/HttpOnly/i.test(login.headers.get('set-cookie') || ''), 'session cookie is HttpOnly');

    const adminProducts = await req('GET', '/api/admin/products', undefined, { Cookie: cookie });
    ok(adminProducts.status === 200 && adminProducts.json.products.length === 6, 'admin lists products');

    const stats = await req('GET', '/api/admin/stats', undefined, { Cookie: cookie });
    ok(stats.json.stats.paidOrders === 1, 'dashboard counts the paid order', String(stats.json.stats.paidOrders));
    ok(stats.json.stats.revenueKobo === 7700000, 'dashboard revenue matches', String(stats.json.stats.revenueKobo));

    const msgs = await req('GET', '/api/admin/messages', undefined, { Cookie: cookie });
    ok(msgs.json.messages.length === 1, 'contact message really was stored (not discarded)',
      String(msgs.json.messages.length));

    const created = await req('POST', '/api/admin/products', {
      name: 'Test Piece', price: 12345, sizes: 'S,M', description: 'temp',
    }, { Cookie: cookie });
    ok(created.status === 201, 'admin can create a product');

    const del = await req('DELETE', `/api/admin/products/${created.json.id}`, undefined, { Cookie: cookie });
    ok(del.status === 200 && del.json.deleted, 'admin can delete an unused product');

    // A product with order history must be hidden, not deleted.
    const hoodieRow = adminProducts.json.products.find((p) => p.slug === 'ynr-icon-hoodie');
    const delUsed = await req('DELETE', `/api/admin/products/${hoodieRow.id}`, undefined, { Cookie: cookie });
    ok(delUsed.json.unpublished === true, 'product with orders is unpublished, not deleted (history preserved)');

    // ---- refunds -----------------------------------------------------
    const orderList = await req('GET', '/api/admin/orders', undefined, { Cookie: cookie });
    const paidOrderRow = orderList.json.orders.find((o) => o.reference === ref);
    ok(Boolean(paidOrderRow), 'the paid order is visible to admin');
    // `other` (reckless-yute, placed earlier via the WhatsApp channel) was
    // never paid — exactly the case a refund attempt should be refused on.
    const unpaidOrderRow = orderList.json.orders.find((o) => o.reference === other.json.order.reference);
    ok(Boolean(unpaidOrderRow), 'the unpaid order is visible to admin');

    const refundOnUnpaid = await req('POST', `/api/admin/orders/${unpaidOrderRow.id}/refund`, {}, { Cookie: cookie });
    ok(refundOnUnpaid.status === 409 && refundOnUnpaid.json.code === 'not_paid',
      'refund refused on an order that was never paid', refundOnUnpaid.json && refundOnUnpaid.json.code);

    const refundReq = await req('POST', `/api/admin/orders/${paidOrderRow.id}/refund`, {}, { Cookie: cookie });
    ok(refundReq.status === 201, 'refund requested on the paid order', String(refundReq.status) + ' ' + refundReq.text.slice(0, 150));
    ok(refundReq.json.refund && refundReq.json.refund.status === 'pending',
      'initiating a refund reports pending, not immediately complete', refundReq.json.refund && refundReq.json.refund.status);

    const refundAgain = await req('POST', `/api/admin/orders/${paidOrderRow.id}/refund`, {}, { Cookie: cookie });
    ok(refundAgain.status === 409 && refundAgain.json.code === 'refund_exists',
      'a second refund request on the same order is refused');

    const refundCheck = await req('POST', `/api/admin/orders/${paidOrderRow.id}/refund/check`, undefined, { Cookie: cookie });
    ok(refundCheck.status === 200 && refundCheck.json.refund.status === 'processed',
      'checking the refund reflects it completing', refundCheck.json && JSON.stringify(refundCheck.json.refund));

    const afterRefund = await req('GET', `/api/orders/${ref}`, undefined, { Cookie: cookie });
    ok(afterRefund.json.order.paymentStatus === 'refunded',
      'order payment status flips to refunded once the check confirms it', afterRefund.json.order.paymentStatus);

    // ---- privacy: lookup and erasure (NDPA) ---------------------------
    const lookupBefore = await req('GET', '/api/admin/privacy/lookup?email=chidi@example.com', undefined, { Cookie: cookie });
    ok(lookupBefore.json.data.orders.length === 1 && lookupBefore.json.data.orders[0].customer_name === 'Chidi Test',
      'privacy lookup finds the order by email, name intact before erasure',
      JSON.stringify(lookupBefore.json.data.orders[0]));

    const erase = await req('POST', '/api/admin/privacy/erase', { email: 'chidi@example.com' }, { Cookie: cookie });
    ok(erase.status === 200 && erase.json.erased.orders === 1,
      'erasure reports one order redacted', JSON.stringify(erase.json));

    const lookupAfter = await req('GET', '/api/admin/privacy/lookup?email=chidi@example.com', undefined, { Cookie: cookie });
    ok(lookupAfter.json.data.orders.length === 0,
      'a second lookup by the original email finds nothing — the order is no longer associated with it',
      JSON.stringify(lookupAfter.json.data));

    // A contact message has no accounting-retention reason to survive, so
    // erasure removes it outright rather than redacting it in place.
    const msgLookupBefore = await req('GET', '/api/admin/privacy/lookup?email=test@example.com', undefined, { Cookie: cookie });
    ok(msgLookupBefore.json.data.messages.length === 1, 'privacy lookup finds the earlier contact message');

    const eraseMsg = await req('POST', '/api/admin/privacy/erase', { email: 'test@example.com' }, { Cookie: cookie });
    ok(eraseMsg.json.erased.messages === 1, 'erasure deletes the contact message outright, not redacts it');

    const msgLookupAfter = await req('GET', '/api/admin/privacy/lookup?email=test@example.com', undefined, { Cookie: cookie });
    ok(msgLookupAfter.json.data.messages.length === 0, 'the contact message is genuinely gone after erasure');

  } catch (e) {
    fail++;
    console.log('  FAIL  unexpected error:', e && e.message);
  } finally {
    // pg-mem lives only inside the killed process, so there is nothing on
    // disk to clean up — unlike the old SQLite temp file. The boot log is
    // the one file this run creates; only worth keeping around on failure.
    server.kill();
    await sleep(200);
    try { fs.closeSync(bootFd); } catch { /* already closed on the failure path */ }
    if (fail === 0) fs.promises.unlink(bootLog).catch(() => {});
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
