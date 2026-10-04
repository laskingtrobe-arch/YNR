'use strict';
const { formatNaira } = require('../lib/util');
const { esc, paymentLabel } = require('./email');

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

const KINDS = {
  success: {
    eyebrow: 'Payment received',
    title: ['Paid.', "It's yours."],
    pill: 'Paid',
    lede: (o) => `Thank you${firstName(o.customer_name) ? `, ${esc(firstName(o.customer_name))}` : ''}. We've received
      <b>${esc(formatNaira(o.amount_paid_kobo || o.total_kobo))}</b> for order <b>${esc(o.reference)}</b> — this exact
      piece is now reserved for you. A receipt is on its way to <b>${esc(o.customer_email)}</b>.`,
    steps: [
      ['We message you on WhatsApp', 'to confirm delivery — usually the same day.'],
      ['Final hand-finishing', 'then your piece is packed with care.'],
      ['It ships', 'and you get an email with tracking the moment it does.'],
    ],
    primary: 'Message us on WhatsApp',
    secondary: 'Back to the shop',
  },
  pending: {
    eyebrow: 'Payment pending',
    title: ['Almost', 'there.'],
    pill: 'Pending',
    lede: (o) => `We haven't seen confirmation for order <b>${esc(o.reference)}</b> yet — sometimes the bank takes a
      moment. If money has left your account, message us on WhatsApp with this reference and we'll sort it.`,
    steps: null,
    primary: 'Message us on WhatsApp',
    secondary: 'Back to the shop',
  },
  refunded: {
    eyebrow: 'Refunded',
    title: ['Order', 'refunded.'],
    pill: 'Refunded',
    lede: (o) => `Order <b>${esc(o.reference)}</b> has been refunded — the money goes back to the card you
      paid with. Depending on your bank, it can take a few working days to show.`,
    steps: null,
    primary: 'Message us on WhatsApp',
    secondary: 'Back to the shop',
  },
  failed: {
    eyebrow: 'Payment failed',
    title: ['Not', 'charged.'],
    pill: 'Not paid',
    lede: (o) => `Your payment for order <b>${esc(o.reference)}</b> didn't go through, and no money was taken.
      Your piece is still held for you for a short while — try again, or confirm on WhatsApp instead.`,
    steps: null,
    primary: 'Confirm on WhatsApp',
    secondary: 'Back to the shop',
  },
};

function lagosDate(ms) {
  return new Date(Number(ms)).toLocaleString('en-GB', {
    timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * The page a customer lands on when Paystack sends them back. Links the
 * storefront's own stylesheet so the header, buttons, grain and the order
 * summary card are the same ones they just saw at checkout.
 */
function paymentPage({ kind, order: o, items, zoneLabel, siteUrl, imageBase = '', whatsappUrl }) {
  const k = KINDS[kind];
  if (!k) throw new Error(`Unknown payment page kind: ${kind}`);
  const paid = kind === 'success';

  const itemRows = items.map((i) => `
      <div class="pp-item">
        ${i.image ? `<img src="${esc(imageBase + i.image)}" alt="${esc(i.name_snapshot)}">` : ''}
        <div class="pp-item-txt"><b>${esc(i.name_snapshot)}</b><span>${i.size ? `Size ${esc(i.size)} · ` : ''}<span style="white-space:nowrap;display:inline;margin:0;">One of one</span></span></div>
        <div class="pp-item-price">${esc(formatNaira(i.price_kobo))}</div>
      </div>`).join('');

  const steps = k.steps ? `
      <ol class="pp-steps">${k.steps.map(([head, rest], n) => `
        <li><span class="pp-num">0${n + 1}</span><span><b>${esc(head)}</b> ${esc(rest)}</span></li>`).join('')}
      </ol>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(k.eyebrow)} — YnR</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="${esc(siteUrl)}/assets/brand/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@500;700;800;900&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${esc(siteUrl)}/css/store.css">
<style>
  .pp-ref{font-family:var(--f-mono); font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--smoke);}
  .pp-grid{display:grid; grid-template-columns:1.1fr .9fr; gap:72px; align-items:start; padding:72px 0 110px;}
  @media (max-width:900px){ .pp-grid{grid-template-columns:1fr; gap:48px; padding:48px 0 80px;} }
  .pp-title{font-size:clamp(64px, 10vw, 128px); margin:22px 0 0;}
  .pp-title span{display:block; color:var(--${kind === 'pending' ? 'bone-dim' : 'oxblood-bright'});}
  .pp-lede{color:var(--bone-dim); font-size:16.5px; line-height:1.7; max-width:520px; margin:30px 0 0;}
  .pp-lede b{color:var(--bone); font-weight:600;}
  .pp-steps{list-style:none; margin:40px 0 0; padding:0; max-width:520px;}
  .pp-steps li{display:flex; gap:18px; padding:16px 0; border-top:1px solid var(--hairline); font-size:14.5px; line-height:1.6; color:var(--bone-dim);}
  .pp-steps li:last-child{border-bottom:1px solid var(--hairline);}
  .pp-steps b{color:var(--bone); font-weight:600;}
  .pp-num{font-family:var(--f-mono); font-size:12px; color:var(--oxblood-bright); font-weight:600; padding-top:2px;}
  .pp-actions{display:flex; flex-wrap:wrap; gap:14px; margin-top:40px;}
  .pp-actions a{text-decoration:none;}
  @media (max-width:560px){ .pp-actions a{width:100%; justify-content:center; text-align:center; box-sizing:border-box;} }
  .pp-card-head{display:flex; justify-content:space-between; align-items:center; margin-bottom:22px;}
  .pp-card-head h4{margin:0;}
  .pp-pill{font-family:var(--f-mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; padding:5px 10px;
    border:1px solid ${paid ? 'var(--bone)' : 'var(--hairline-strong)'}; color:${paid ? 'var(--void)' : 'var(--bone-dim)'};
    background:${paid ? 'var(--bone)' : 'transparent'};}
  .pp-item{display:flex; gap:16px; align-items:center; padding:0 0 18px; margin-bottom:6px; border-bottom:1px solid var(--hairline);}
  .pp-item img{width:64px; height:80px; object-fit:cover; background:var(--ink); flex:none;}
  .pp-item-txt{flex:1; min-width:0;}
  .pp-item-txt b{display:block; font-size:15px; font-weight:600;}
  .pp-item-txt span{display:block; font-family:var(--f-mono); font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--smoke); margin-top:6px;}
  .pp-item-price{font-family:var(--f-mono); font-size:13px; white-space:nowrap;}
  .pp-meta{margin-top:24px; padding-top:20px; border-top:1px solid var(--hairline); display:grid; gap:10px;}
  .pp-meta div{display:flex; justify-content:space-between; gap:14px; font-size:13px; color:var(--smoke);}
  .pp-meta div span:last-child{font-family:var(--f-mono); color:var(--bone-dim); text-align:right;}
</style>
</head><body>
<div class="grain" aria-hidden="true"></div>
<header class="site-nav"><div class="nav-inner">
  <a href="${esc(siteUrl)}/" class="wordmark">Yn<span>R</span></a>
  <span class="pp-ref">Order ${esc(o.reference)}</span>
</div></header>

<main class="wrap"><div class="pp-grid">
  <section>
    <div class="eyebrow">${esc(k.eyebrow)}</div>
    <h1 class="display pp-title">${esc(k.title[0])}<span>${esc(k.title[1])}</span></h1>
    <p class="pp-lede">${k.lede(o)}</p>
    ${steps}
    <div class="pp-actions">
      <a class="btn-primary" href="${esc(whatsappUrl)}" target="_blank" rel="noopener">${esc(k.primary)} &rarr;</a>
      <a class="btn-outline" href="${esc(siteUrl)}/">${esc(k.secondary)}</a>
    </div>
  </section>

  <aside class="summary">
    <div class="pp-card-head"><h4>Your order</h4><span class="pp-pill">${esc(k.pill)}</span></div>
    ${itemRows}
    <div class="sum-line"><span>Subtotal</span><span>${esc(formatNaira(o.subtotal_kobo))}</span></div>
    <div class="sum-line"><span>Delivery${zoneLabel ? ` · ${esc(zoneLabel)}` : ''}</span><span>${o.delivery_kobo ? esc(formatNaira(o.delivery_kobo)) : 'To be confirmed'}</span></div>
    <div class="sum-total"><span>${paid ? 'Total paid' : 'Total'}</span><span>${esc(formatNaira(o.amount_paid_kobo || o.total_kobo))}</span></div>
    <div class="pp-meta">
      <div><span>Reference</span><span>${esc(o.reference)}</span></div>
      ${paid ? `<div><span>Paid with</span><span>${esc(paymentLabel(o))}</span></div>
      <div><span>Date</span><span>${esc(lagosDate(o.paid_at || o.created_at))}</span></div>` : ''}
    </div>
  </aside>
</div></main>

<footer><div class="wrap"><div class="footer-bottom">
  <small>© ${new Date().getFullYear()} YnR — Young &amp; Reckless. Hand-painted in Abuja.</small>
  <small><a href="${esc(siteUrl)}/privacy.html" style="color:inherit;">Privacy</a> ·
    <a href="${esc(siteUrl)}/terms.html" style="color:inherit;">Terms</a> ·
    <a href="${esc(siteUrl)}/shipping-returns.html" style="color:inherit;">Shipping &amp; Returns</a></small>
</div></div></footer>
</body></html>`;
}

module.exports = { paymentPage };
