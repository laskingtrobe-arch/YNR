/* ==========================================================================
   App
   Per-page boot and DOM wiring. Each page names itself on <body
   data-page="...">; the pieces every page shares (nav, bag) are wired on all
   of them. Loaded last: every function it calls is defined above it.
   ========================================================================== */

const PAGE = document.body.dataset.page || '';

function toggleSizeGuide(open) {
  const modal = document.getElementById('sizeModal');
  if (modal) modal.classList.toggle('open', open);
}

/* ---------------- wiring ----------------
   All DOM listeners live here rather than being scattered through the other
   files, so there is one place to look when something is not responding. */
function wireUp() {
  const toggle = document.getElementById('mobileToggle');
  const links = document.getElementById('navLinks');
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-expanded', String(links.classList.toggle('open')));
  });

  const themeBtn = document.getElementById('themeToggle');
  themeBtn.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    setTheme(theme);
    themeBtn.setAttribute('aria-pressed', String(theme === 'light'));
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* switched, just not remembered */ }
  });

  const modal = document.getElementById('sizeModal');
  if (modal) {
    modal.addEventListener('click', (e) => { if (e.target === modal) toggleSizeGuide(false); });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleSizeGuide(false); toggleCart(false); }
  });

  // Delegated rather than attached per-link: catches the floating button,
  // the footer links and every JS-built wa.me URL (checkout, order-now,
  // repaint) in one place, including any added later without more wiring.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href*="wa.me"]');
    if (link) track('whatsapp_click', { slug: currentProduct || '' });
  });
}

/* What each page loads once it's wired up. Pages not listed here (story,
   visit, contact, legal) are static apart from the shared nav and bag. */
const PAGE_INIT = {
  home: () => loadCatalogue({ grid: 'featuredGrid', limit: 3 }),
  shop: () => loadCatalogue({ grid: 'shopGrid', filters: 'shopFilters' }),
  product: () => loadProductPage(),
  checkout: () => initCheckout(),
};

/* ---------------- boot ---------------- */
function start() {
  wireUp();
  loadBag();
  renderCart();
  track('page_view');
  if (PAGE_INIT[PAGE]) PAGE_INIT[PAGE]();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
