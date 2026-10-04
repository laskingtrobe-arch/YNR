/* ==========================================================================
   Layout
   The header, footer, bag drawer and WhatsApp button every page shares, in
   one place: changing the nav or the footer is one edit here, not one per
   page.

   Include it as the very first thing inside <body>. The header is written in
   right there, synchronously, so it's in place before the page first paints.
   Each page then calls siteFooter() just after its own content, and
   siteTransmission() wherever it wants a strip of alien code.
   ========================================================================== */

const NAV = [
  { href: '/shop', label: 'Shop', section: 'shop' },
  { href: '/gallery', label: 'Gallery', section: 'gallery' },
  { href: '/story', label: 'Our Story', section: 'story' },
  { href: '/visit', label: 'Visit Us', section: 'visit' },
  { href: '/contact', label: 'Contact', section: 'contact' },
];

const ICON = {
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="10" width="16" height="10" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  waLine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.87.5 3.63 1.44 5.15L2 22l5.1-1.53a9.87 9.87 0 0 0 4.94 1.32h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Z"/></svg>',
  waSolid: '<svg viewBox="0 0 24 24"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.87.5 3.63 1.44 5.15L2 22l5.1-1.53a9.87 9.87 0 0 0 4.94 1.32h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm5.8 14.1c-.24.68-1.4 1.3-1.94 1.38-.5.08-1.12.11-1.8-.11-.42-.13-.95-.31-1.64-.6-2.9-1.25-4.79-4.16-4.94-4.35-.14-.2-1.18-1.57-1.18-3 0-1.42.75-2.12 1.02-2.41.26-.28.58-.36.77-.36.2 0 .39 0 .56.01.18.01.42-.07.65.5.24.58.82 2 .9 2.15.07.14.12.31.02.5-.09.19-.14.31-.28.48-.14.17-.29.37-.42.5-.14.14-.28.29-.12.56.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.23 2.21 1.37.28.14.44.12.6-.07.17-.19.71-.83.9-1.11.19-.28.38-.24.63-.14.26.09 1.65.78 1.93.92.28.14.47.21.53.33.07.12.07.68-.17 1.35Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/></svg>',
};

const TICKER = ['Hand-painted in Abuja', 'Every piece is one-of-one', '4 years of YnR', 'Worldwide delivery'];

/* Intercepted transmissions: strips of alien code and messages that drift
   side to side across the site (js/glitch.js speeds them up as the page
   scrolls). The messages carry the home page film's alien-invasion story.
   They're decoration, so screen readers skip them. Already HTML-escaped. */
const TRANSMISSIONS = [
  'Incoming transmission',
  'Signal locked // Mpape, Abuja // 9.13°N 7.49°E',
  'They came for the one-of-one',
  'Subject acquired: hand-painted, not printed',
  'Abduction in progress',
  'Earth style detected // extracting',
  'Young &amp; Reckless // cleared for take-off',
  'Transmission 07 // out of this world',
];
const TX_GLYPHS = 'ΣΞΨΩΔΛΠΦΓΘ∑∏∞≈≠≡±×µ¤§▓▒░█■□▲►▼◄◊';

// "Alien code": glyph runs, hex and binary. Made from a fixed seed so a
// strip reads the same on every visit instead of reshuffling.
function txCode(seed, count) {
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const parts = [];
  for (let n = 0; n < count; n++) {
    const kind = Math.floor(rnd() * 3);
    let part = '';
    if (kind === 0) for (let i = 0, len = 4 + Math.floor(rnd() * 6); i < len; i++) part += TX_GLYPHS[Math.floor(rnd() * TX_GLYPHS.length)];
    else if (kind === 1) part = `0x${Math.floor(rnd() * 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
    else for (let i = 0; i < 8; i++) part += rnd() < 0.5 ? '0' : '1';
    parts.push(part);
  }
  return parts;
}

// A strip: a row of messages and a row of code moving the opposite way,
// each written out twice so its loop joins up seamlessly. `start` picks
// which message leads, so strips on the same page differ; `extra` adds
// classes and `beat` makes it one of the film's timed layers.
function transmissionHtml(start = 0, extra = '', beat = '') {
  const msgs = TRANSMISSIONS.map((_, i) => TRANSMISSIONS[(i + start) % TRANSMISSIONS.length])
    .map((m) => `<span class="tx-msg"><b>//</b>${m}</span>`).join('');
  const code = txCode(start + 7, 16).map((c) => `<span>${c}</span>`).join('');
  return `<div class="transmission${extra ? ` ${extra}` : ''}" aria-hidden="true"${beat ? ` data-beat="${beat}"` : ''}>
  <div class="tx-row"><div class="tx-track">${msgs}${msgs}</div></div>
  <div class="tx-row tx-code"><div class="tx-track">${code}${code}</div></div>
</div>`;
}

function siteHeaderHtml(section) {
  const items = TICKER.concat(TICKER).map((t) => `<span>${t.toUpperCase().replace('YNR', 'YnR')}</span>`).join('');
  const links = NAV.map((n) =>
    `<a href="${n.href}"${n.section === section ? ' aria-current="page"' : ''}>${n.label}</a>`).join('');
  return `<div class="grain" aria-hidden="true"></div>
<header class="site-nav">
  <div class="ticker" aria-hidden="true"><div class="ticker-track">${items}</div></div>
  <div class="nav-inner">
    <a href="/" class="wordmark" aria-label="YnR home">Yn<span>R</span></a>
    <nav class="nav-links" id="navLinks" aria-label="Main">${links}</nav>
    <div class="nav-actions">
      <button class="icon-btn" aria-label="Open bag" onclick="toggleCart(true)">${ICON.bag}<span class="bag-count" id="bagCount">0</span></button>
      <button class="mobile-toggle" id="mobileToggle" aria-label="Toggle menu" aria-controls="navLinks" aria-expanded="false">${ICON.menu}</button>
    </div>
  </div>
</header>`;
}

function siteFooterHtml() {
  const wa = `https://wa.me/${WA_NUMBER}`;
  return `${transmissionHtml(3)}
<footer>
  <div class="wrap">
    <div class="footer-top">
      <div class="footer-brand">
        <a href="/" class="wordmark">Yn<span>R</span></a>
        <p>Hand-painted, one-of-one streetwear out of Mpape, Abuja. Four years of making pieces that don't come off a factory line.</p>
        <div class="foot-social">
          <a href="${wa}" target="_blank" rel="noopener" aria-label="WhatsApp">${ICON.waLine}</a>
          <a href="https://www.instagram.com/ynr_multiverse/" target="_blank" rel="noopener" aria-label="Instagram: @ynr_multiverse">${ICON.instagram}</a>
        </div>
      </div>
      <div class="foot-col">
        <h5>Shop</h5>
        <a href="/shop">All Pieces</a>
        <a href="#" onclick="toggleCart(true); return false;">Your Bag</a>
        <a href="/visit#delivery">Delivery</a>
      </div>
      <div class="foot-col">
        <h5>Visit</h5>
        <p>Suite 302, Aula Plaza,<br>Mpape, Abuja, Nigeria</p>
        <a href="${wa}" target="_blank" rel="noopener">WhatsApp: 0902 694 7815</a>
        <a href="/visit">Visit Us</a>
        <a href="/contact">Contact</a>
      </div>
      <div class="foot-col">
        <h5>Legal</h5>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms &amp; Conditions</a>
        <a href="/shipping-returns">Shipping &amp; Returns</a>
      </div>
    </div>
    <div class="footer-bottom">
      <small>© ${new Date().getFullYear()} YnR — Young &amp; Reckless. Hand-painted in Abuja.</small>
    </div>
  </div>
</footer>

<a class="wa-float" href="${wa}" target="_blank" rel="noopener" aria-label="Chat with us on WhatsApp">${ICON.waSolid}</a>

<div class="cart-overlay" id="cartOverlay" onclick="toggleCart(false)"></div>
<aside class="cart-drawer" id="cartDrawer" aria-hidden="true">
  <div class="cart-head"><h3 id="cartHeadTitle">Your Bag (0)</h3><button class="modal-close" onclick="toggleCart(false)" aria-label="Close bag">✕</button></div>
  <div class="cart-items" id="cartItems"><div class="cart-empty">Your bag is empty. Add a piece to get started.</div></div>
  <div class="cart-foot">
    <div class="cart-subtotal"><span>Subtotal</span><span id="cartSubtotal">₦0</span></div>
    <button class="btn-oxblood" onclick="goToCheckout()">Checkout ${ICON.arrow}</button>
    <div class="secure-note">${ICON.lock} Pay by card, or confirm on WhatsApp — your choice at the next step</div>
  </div>
</aside>`;
}

document.currentScript.insertAdjacentHTML('afterend',
  siteHeaderHtml(document.body.dataset.section || document.body.dataset.page || ''));

function siteFooter() {
  document.currentScript.insertAdjacentHTML('afterend', siteFooterHtml());
}

// A transmission strip, right where it's called from (see transmissionHtml).
function siteTransmission(start, extra, beat) {
  document.currentScript.insertAdjacentHTML('afterend', transmissionHtml(start, extra, beat));
}
