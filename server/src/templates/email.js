'use strict';
const { formatNaira } = require('../lib/util');

// Gmail strips <link>/@import, so web fonts never load there: the display
// stack falls back to the closest condensed face each platform actually has
// (Arial Narrow on Windows, Helvetica Neue Condensed on Apple, Roboto
// Condensed on Android). The wordmark is an image for the same reason.
const DISPLAY = "'Big Shoulders Display','Arial Narrow','HelveticaNeue-CondensedBold','Roboto Condensed','sans-serif-condensed',Arial,sans-serif";
const BODY = "Inter,'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'IBM Plex Mono',SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

// Light card, dark masthead: a fully dark email gets colour-inverted to light
// by Gmail on iPhone, while a light one only gets darkened — this survives both.
const C = {
  void: '#0a0a0a', bone: '#f2efe9', boneDim: '#d8d4cb', page: '#ece9e3', paper: '#ffffff',
  ink: '#161616', muted: '#5c5952', smoke: '#8f8b84', line: '#e6e2da', oxblood: '#a8181d',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

function lagosDate(ms) {
  return new Date(Number(ms)).toLocaleString('en-GB', {
    timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const COPY = {
  order_placed: {
    eyebrow: 'Order received',
    title: (o) => `We've got your order, ${firstName(o.customer_name)}.`,
    lede: (o) => `Your piece is held for you while we confirm the details with you on WhatsApp. ` +
      `Nothing is charged until we confirm — your reference is <b style="color:${C.bone};white-space:nowrap;">${esc(o.reference)}</b>.`,
    subject: (o) => `Your YnR order ${o.reference}`,
    preheader: (o) => `Order ${o.reference} received — ${formatNaira(o.total_kobo)}. Nothing is charged until we confirm with you.`,
    totalLabel: 'Total',
    steps: [
      'We message you on WhatsApp to confirm your size, delivery and payment.',
      'Once you have paid, your piece gets its final hand-finishing and is packed.',
      'It ships — and you get an email with tracking the moment it does.',
    ],
    cta: 'Confirm on WhatsApp',
  },
  payment_received: {
    eyebrow: 'Payment received',
    title: (o) => `It's yours, ${firstName(o.customer_name)}.`,
    lede: (o) => `We've received <b style="color:${C.bone}">${esc(formatNaira(o.amount_paid_kobo || o.total_kobo))}</b> ` +
      `for order <b style="color:${C.bone};white-space:nowrap;">${esc(o.reference)}</b>. This exact piece is now reserved for you — ` +
      `there isn't another one.`,
    subject: (o) => `Payment received — ${o.reference}`,
    preheader: (o) => `Receipt for ${o.reference}: ${formatNaira(o.amount_paid_kobo || o.total_kobo)} paid. Your piece is reserved.`,
    totalLabel: 'Total paid',
    steps: [
      'We message you on WhatsApp to confirm delivery.',
      'Your piece gets its final hand-finishing and is packed with care.',
      'It ships — and you get an email with tracking the moment it does.',
    ],
    cta: 'Message us on WhatsApp',
  },
};

function paymentLabel(o) {
  if (o.payment_status !== 'paid') return 'Awaiting payment';
  return o.channel === 'paystack' ? 'Card · Paystack' : 'Bank transfer';
}

const label = (text) =>
  `<div style="font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:${C.smoke};margin:0 0 14px;">${esc(text)}</div>`;

const rule = (top = 26, bottom = 26) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:${top}px 0 ${bottom}px;"><div style="height:1px;line-height:1px;font-size:0;background:${C.line};">&nbsp;</div></td></tr></table>`;

function itemRows(items, imageBase) {
  return items.map((i) => {
    const img = i.image
      ? `<td width="88" valign="top" style="width:88px;padding:0 18px 0 0;">
           <img class="item-img" src="${esc(imageBase + i.image)}" width="88" height="110" alt="${esc(i.name_snapshot)}"
                style="display:block;width:88px;height:110px;object-fit:cover;border:0;background:${C.page};"></td>`
      : '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tr>
      ${img}
      <td valign="top" style="font-family:${BODY};">
        <div style="font-size:16px;line-height:22px;font-weight:700;color:${C.ink};">${esc(i.name_snapshot)}</div>
        <div style="font-family:${MONO};font-size:11px;line-height:18px;letter-spacing:1.5px;text-transform:uppercase;color:${C.muted};margin-top:6px;">
          ${i.size ? `Size ${esc(i.size)} · ` : ''}One of one</div>
      </td>
      <td valign="top" align="right" style="font-family:${MONO};font-size:13px;line-height:22px;color:${C.ink};white-space:nowrap;padding-left:12px;">${esc(formatNaira(i.price_kobo))}</td>
    </tr></table>`;
  }).join('');
}

function totalsRows(o, zoneLabel, totalLabel) {
  const delivery = o.delivery_kobo ? formatNaira(o.delivery_kobo) : 'To be confirmed';
  const line = (k, v) => `<tr>
      <td style="font-family:${BODY};font-size:14px;line-height:20px;color:${C.muted};padding:10px 0;border-bottom:1px solid ${C.line};">${k}</td>
      <td align="right" style="font-family:${MONO};font-size:13px;line-height:20px;color:${C.ink};padding:10px 0;border-bottom:1px solid ${C.line};white-space:nowrap;">${v}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${line('Subtotal', esc(formatNaira(o.subtotal_kobo)))}
    ${line(`Delivery${zoneLabel ? ` <span style="color:${C.smoke}">· ${esc(zoneLabel)}</span>` : ''}`, esc(delivery))}
    <tr>
      <td style="font-family:${DISPLAY};font-size:22px;line-height:26px;font-weight:800;text-transform:uppercase;color:${C.ink};padding:18px 0 0;">${esc(totalLabel)}</td>
      <td align="right" style="font-family:${DISPLAY};font-size:22px;line-height:26px;font-weight:800;color:${C.ink};padding:18px 0 0;white-space:nowrap;">${esc(formatNaira(o.amount_paid_kobo || o.total_kobo))}</td>
    </tr></table>`;
}

function detailCell(k, v, extraStyle = '') {
  return `<td class="stack" valign="top" style="padding:0 12px 14px 0;${extraStyle}">
    <div style="font-family:${MONO};font-size:10.5px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;color:${C.smoke};">${esc(k)}</div>
    <div style="font-family:${BODY};font-size:14px;line-height:20px;color:${C.ink};margin-top:4px;">${v}</div></td>`;
}

/**
 * Renders the customer's order email. `kind` is 'order_placed' (sent the
 * moment they check out) or 'payment_received' (their receipt). Every value
 * that came from a customer is escaped — a name is user input like any other.
 */
function receiptEmail({ kind, order: o, items, zoneLabel, siteUrl, imageBase = siteUrl, whatsappUrl }) {
  const copy = COPY[kind];
  if (!copy) throw new Error(`Unknown receipt kind: ${kind}`);
  const paid = o.payment_status === 'paid';
  const address = [o.address_line, o.city, o.state, o.country].filter(Boolean).map(esc).join(', ');
  const steps = copy.steps.map((s, n) => `<tr>
      <td valign="top" width="34" style="width:34px;font-family:${MONO};font-size:12px;line-height:22px;color:${C.oxblood};font-weight:600;">0${n + 1}</td>
      <td valign="top" style="font-family:${BODY};font-size:14px;line-height:22px;color:${C.ink};padding:0 0 10px;">${esc(s)}</td></tr>`).join('');

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(copy.subject(o))}</title>
<style>
  @media (max-width:620px){
    .container{width:100%!important}
    .px{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:38px!important;line-height:38px!important}
    .stack{display:block!important;width:100%!important;padding-right:0!important}
    .item-img{width:72px!important;height:90px!important}
  }
</style></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${esc(copy.preheader(o))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
<tr><td align="center" style="padding:24px 12px 32px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

  <tr><td bgcolor="${C.void}" class="px" style="background:${C.void};padding:28px 40px 44px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle"><a href="${esc(siteUrl)}" style="text-decoration:none;"><img src="${esc(siteUrl)}/assets/brand/email-wordmark.png" width="66" height="40" alt="YnR" style="display:block;border:0;"></a></td>
      <td valign="middle" align="right" style="font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.smoke};">Order ${esc(o.reference)}</td>
    </tr></table>
    <div style="height:38px;line-height:38px;font-size:0;">&nbsp;</div>
    <div style="font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:3px;text-transform:uppercase;color:${C.oxblood};">
      <span style="display:inline-block;width:22px;height:1px;background:${C.oxblood};vertical-align:middle;margin:0 10px 3px 0;"></span>${esc(copy.eyebrow)}</div>
    <h1 class="h1" style="margin:16px 0 0;font-family:${DISPLAY};font-size:46px;line-height:44px;font-weight:800;letter-spacing:-0.5px;text-transform:uppercase;color:${C.bone};">${esc(copy.title(o))}</h1>
    <p style="margin:20px 0 0;font-family:${BODY};font-size:15px;line-height:24px;color:${C.boneDim};">${copy.lede(o)}</p>
  </td></tr>
  <tr><td bgcolor="${C.oxblood}" style="background:${C.oxblood};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>

  <tr><td bgcolor="${C.paper}" class="px" style="background:${C.paper};padding:38px 40px 40px;">
    ${label(items.length > 1 ? 'Your pieces' : 'Your piece')}
    ${itemRows(items, imageBase)}
    ${totalsRows(o, zoneLabel, copy.totalLabel)}
    ${rule(30, 22)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      ${detailCell('Order', `<span style="font-family:${MONO};font-size:13px;">${esc(o.reference)}</span>`)}
      ${detailCell(paid ? 'Paid' : 'Placed', esc(lagosDate(paid && o.paid_at ? o.paid_at : o.created_at)))}
      ${detailCell('Payment', paid
        ? `<span style="display:inline-block;background:${C.void};color:${C.bone};font-family:${MONO};font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;padding:3px 8px;margin-right:6px;">Paid</span>${esc(paymentLabel(o))}`
        : esc(paymentLabel(o)))}
    </tr></table>
    ${rule(12, 26)}
    ${label('Delivering to')}
    <div style="font-family:${BODY};font-size:14px;line-height:22px;color:${C.ink};">
      <b>${esc(o.customer_name)}</b><br>${esc(o.customer_phone)}${address ? `<br>${address}` : ''}
      ${!o.delivery_kobo ? `<br><span style="color:${C.muted}">Delivery cost confirmed with you on WhatsApp before you pay.</span>` : ''}
    </div>
    ${rule()}
    ${label('What happens next')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${steps}</table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;"><tr>
      <td bgcolor="${C.void}" style="background:${C.void};">
        <a href="${esc(whatsappUrl)}" style="display:inline-block;padding:16px 28px;font-family:${MONO};font-size:12px;line-height:16px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${C.bone};text-decoration:none;">${esc(copy.cta)} &rarr;</a>
      </td></tr></table>
    <p style="margin:16px 0 0;font-family:${BODY};font-size:13px;line-height:20px;color:${C.muted};">Questions? Just reply to this email.</p>
  </td></tr>

  <tr><td class="px" align="center" style="padding:30px 40px 0;font-family:${BODY};font-size:12px;line-height:19px;color:${C.muted};">
    <b style="color:${C.ink};">YnR — Young &amp; Reckless</b><br>Hand-painted, one-of-one streetwear · Mpape, Abuja<br>
    <a href="${esc(siteUrl)}/" style="color:${C.muted};">Shop</a> &nbsp;·&nbsp;
    <a href="${esc(siteUrl)}/shipping-returns.html" style="color:${C.muted};">Shipping &amp; Returns</a> &nbsp;·&nbsp;
    <a href="${esc(siteUrl)}/privacy.html" style="color:${C.muted};">Privacy</a>
    <div style="font-family:${MONO};font-size:10.5px;letter-spacing:1px;color:${C.smoke};margin-top:14px;">Keep this email as your ${paid ? 'receipt' : 'order record'}.</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    copy.title(o).toUpperCase(),
    '',
    copy.lede(o).replace(/<[^>]+>/g, ''),
    '',
    ...items.map((i) => `- ${i.name_snapshot}${i.size ? ` (Size ${i.size})` : ''} — ${formatNaira(i.price_kobo)}`),
    `Subtotal: ${formatNaira(o.subtotal_kobo)}`,
    `Delivery: ${o.delivery_kobo ? formatNaira(o.delivery_kobo) : 'To be confirmed'}`,
    `${copy.totalLabel}: ${formatNaira(o.amount_paid_kobo || o.total_kobo)}`,
    '',
    `Order: ${o.reference}`,
    `Payment: ${paymentLabel(o)}`,
    '',
    'What happens next:',
    ...copy.steps.map((s, n) => `${n + 1}. ${s}`),
    '',
    `WhatsApp: ${whatsappUrl}`,
    'Questions? Just reply to this email.',
    '',
    '— YnR, Young & Reckless',
  ].join('\n');

  return { subject: copy.subject(o), html, text };
}

module.exports = { receiptEmail, esc, paymentLabel };
