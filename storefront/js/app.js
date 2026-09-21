/* ==========================================================================
   App
   View switching, DOM wiring, and boot. Loaded last: every function it wires
   up is defined by the scripts above it.
   ========================================================================== */

/* ---------------- views ---------------- */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById('view-' + name);
  if (el) el.classList.add('active');
  document.getElementById('navLinks').classList.remove('open');
  window.scrollTo({ top: 0 });
  // `path` carries the view name (home, product, checkout, ...) — not
  // `slug`, which is reserved for an actual product slug. openProduct()
  // fires the per-piece product_view event separately, once it knows which.
  track('page_view', { path: '/' + name });
}

function scrollToId(id) {
  showView('home');
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function toggleSizeGuide(open) {
  document.getElementById('sizeModal').classList.toggle('open', open);
}

/* ---------------- wiring ----------------
   All DOM listeners live here rather than being scattered through the other
   files, so there is one place to look when something is not responding. */
function wireUp() {
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (el.dataset.scroll) scrollToId(el.dataset.scroll);
      else showView(el.dataset.view);
    });
  });

  document.getElementById('mobileToggle').addEventListener('click', () => {
    document.getElementById('navLinks').classList.toggle('open');
  });

  document.getElementById('sizeModal').addEventListener('click', (e) => {
    if (e.target.id === 'sizeModal') toggleSizeGuide(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleSizeGuide(false); toggleCart(false); }
  });

  document.getElementById('coZone').addEventListener('change', updateCheckoutTotals);
  document.getElementById('payCardBtn').addEventListener('click', () => placeOrder('paystack'));
  document.getElementById('payWaBtn').addEventListener('click', () => placeOrder('whatsapp'));

  // Delegated rather than attached per-link: catches the floating button,
  // the footer links and every JS-built wa.me URL (checkout, order-now,
  // repaint) in one place, including any added later without more wiring.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href*="wa.me"]');
    if (link) track('whatsapp_click', { slug: currentProduct || '' });
  });
}

/* ---------------- boot ---------------- */
function start() {
  wireUp();
  loadBag();
  renderCart();
  showView('home');
  loadCatalogue();
  loadZones();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
