/* ==========================================================================
   Bag
   Held in localStorage rather than a plain variable, so a refresh or a
   return visit no longer empties it.
   ========================================================================== */

let bag = [];

function saveBag() {
  try {
    localStorage.setItem(BAG_KEY, JSON.stringify(bag));
  } catch (e) {
    /* private browsing, or storage full. The bag still works for this visit. */
  }
}

function loadBag() {
  try {
    const raw = localStorage.getItem(BAG_KEY);
    bag = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(bag)) bag = [];
  } catch (e) {
    bag = [];
  }
}

const bagSubtotal = () => bag.reduce((sum, i) => sum + i.priceKobo, 0);

/* Every piece is one-of-one, so the same slug can only ever be in the bag
   once. Adding it again just opens the drawer. */
function addToBag() {
  const p = PRODUCTS[currentProduct];
  if (!p) return;

  if (bag.some((i) => i.slug === p.slug)) {
    toggleCart(true);
    return;
  }

  bag.push({
    slug: p.slug, name: p.name, priceKobo: p.priceKobo,
    size: selectedSize, img: p.image,
  });
  saveBag();
  renderCart();
  toggleCart(true);
}

function removeFromBag(idx) {
  bag.splice(idx, 1);
  saveBag();
  renderCart();
}

function renderCart() {
  const count = document.getElementById('bagCount');
  if (count) count.textContent = bag.length;

  const title = document.getElementById('cartHeadTitle');
  if (title) title.textContent = `Your Bag (${bag.length})`;

  const itemsEl = document.getElementById('cartItems');
  if (!itemsEl) return;

  itemsEl.innerHTML = bag.length === 0
    ? '<div class="cart-empty">Your bag is empty. Add a piece to get started.</div>'
    : bag.map((item, idx) => `
      <div class="cart-line">
        <div class="thumb"><img src="${imgUrl(item.img)}" alt="${escapeAttr(item.name)}"></div>
        <div class="cl-info">
          <h5>${escapeHtml(item.name)}</h5>
          <span>${item.size ? 'Size ' + escapeHtml(item.size) : ''}</span>
          <button class="cl-remove" onclick="removeFromBag(${idx})">Remove</button>
        </div>
        <div class="cl-price">${kobo(item.priceKobo)}</div>
      </div>`).join('');

  const sub = document.getElementById('cartSubtotal');
  if (sub) sub.textContent = kobo(bagSubtotal());
}

function toggleCart(open) {
  document.getElementById('cartDrawer').classList.toggle('open', open);
  document.getElementById('cartOverlay').classList.toggle('open', open);
}

/* The bag now leads to a real checkout. It used to jump straight to a
   WhatsApp message that was never recorded anywhere. */
function goToCheckout() {
  if (!bag.length) {
    toggleCart(true);
    return;
  }
  toggleCart(false);
  showView('checkout');
  renderCheckout();
  window.scrollTo({ top: 0 });
}

/* Direct WhatsApp enquiry about a single piece. Kept because it is how YnR
   actually talks to customers, but it no longer pretends to be checkout. */
function orderThisNow() {
  const p = PRODUCTS[currentProduct];
  if (!p) return;

  const msg = p.isSold
    ? `Hi YnR, the ${p.name} is sold — could you repaint one for me?`
    : `Hi YnR, I'd like to order the ${p.name}${selectedSize ? ' — Size ' + selectedSize : ''} — ${p.priceLabel}.`;

  window.open(`https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(msg)}`, '_blank');
}
