/* ==========================================================================
   Catalogue
   The shop grid and the product detail page. Nothing about the pieces is
   hardcoded here: it all comes from the API, so the owner can add, price and
   retire pieces from the admin panel without anyone editing code.
   ========================================================================== */

let PRODUCTS = {};        // slug -> product
let SHOP_ORDER = [];      // display order, as returned by the API
let ZONES = [];           // delivery zones
let currentProduct = null;
let selectedSize = null;

/* ---------------- grid ---------------- */
function productCard(p) {
  const sold = p.isSold;
  const tag = sold ? 'Sold — Repaint' : (p.isReserved ? 'Reserved' : 'One Of One');
  return `
  <article class="product-card ${sold ? 'is-sold' : ''}" onclick="openProduct('${p.slug}')"
           tabindex="0" role="button" aria-label="View ${escapeAttr(p.name)}"
           onkeydown="if(event.key==='Enter')openProduct('${p.slug}')">
    <div class="product-media">
      <div class="one-tag ${sold ? 'sold-badge' : ''}">${tag}</div>
      <img src="${imgUrl(p.image)}" alt="${escapeAttr(p.name)}, hand-painted by YnR" loading="lazy">
      <div class="quick-add" onclick="event.stopPropagation(); openProduct('${p.slug}')">
        ${sold ? 'Ask For A Repaint' : 'View &amp; Order'}
      </div>
    </div>
    <div class="product-info">
      <div><h4>${escapeHtml(p.name)}</h4><div class="pmeta">${escapeHtml(p.category)}</div></div>
      <div class="price">${escapeHtml(p.priceLabel)}</div>
    </div>
  </article>`;
}

function renderGrid(target, list) {
  if (!target) return;
  target.innerHTML = list.map(productCard).join('');
}

async function loadCatalogue() {
  const grid = document.getElementById('shopGrid');
  if (grid) {
    grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
  }
  try {
    const data = await api('GET', '/products');
    PRODUCTS = {};
    SHOP_ORDER = [];
    data.products.forEach((p) => { PRODUCTS[p.slug] = p; SHOP_ORDER.push(p.slug); });
    renderGrid(grid, data.products);
  } catch (e) {
    if (grid) {
      grid.innerHTML = `<div class="load-msg">${escapeHtml(e.message)}
        <br><br><button class="btn-outline" onclick="loadCatalogue()">Try again</button></div>`;
    }
  }
}

async function loadZones() {
  try {
    ZONES = (await api('GET', '/delivery-zones')).zones;
  } catch (e) {
    ZONES = [];
  }
}

/* ---------------- product detail ---------------- */
async function openProduct(slug) {
  showView('product');
  window.scrollTo({ top: 0 });

  try {
    const data = await api('GET', '/products/' + encodeURIComponent(slug));
    const p = data.product;
    PRODUCTS[p.slug] = p;
    currentProduct = p.slug;
    selectedSize = (p.sizes && p.sizes[0]) || '';
    track('product_view', { slug: p.slug });

    document.getElementById('pdpEyebrow').textContent = 'Hand-Painted · ' + p.category;
    document.getElementById('pdpName').textContent = p.name;
    document.getElementById('pdpCrumbName').textContent = p.name;
    document.getElementById('pdpCategory').textContent = p.category;
    document.getElementById('pdpPrice').textContent = p.priceLabel;
    document.getElementById('pdpDesc').textContent = p.description;
    document.getElementById('pdpMainImg').src = imgUrl(p.image);
    document.getElementById('pdpMainImg').alt = p.name;
    document.getElementById('pdpOneTag').textContent =
      p.isSold ? 'Sold — Repaint Available' : 'One Of One';

    document.getElementById('sizeRow').innerHTML = (p.sizes || []).map((s) =>
      `<button class="size-chip ${s === selectedSize ? 'active' : ''}"
               onclick="selectSize('${escapeAttr(s)}',this)">${escapeHtml(s)}</button>`
    ).join('');

    renderPdpActions(p);
    renderGrid(document.getElementById('relatedGrid'), data.related);
  } catch (e) {
    document.getElementById('pdpName').textContent = 'Piece unavailable';
    document.getElementById('pdpDesc').textContent = e.message;
  }
}

/* A sold one-of-one stays on the site, as the shop copy promises, but the
   action becomes a repaint request rather than an add-to-bag that could
   never be fulfilled. */
function renderPdpActions(p) {
  const el = document.querySelector('.pdp-actions');
  if (!el) return;

  el.innerHTML = p.isSold
    ? `<button class="btn-oxblood" onclick="requestRepaint()">Request A Repaint</button>
       <button class="btn-outline" onclick="orderThisNow()">Ask On WhatsApp</button>`
    : `<button class="btn-oxblood" onclick="addToBag()">
         Add To Bag
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>
       </button>
       <button class="btn-outline" onclick="orderThisNow()">Order On WhatsApp</button>`;
}

function selectSize(s, el) {
  selectedSize = s;
  el.parentElement.querySelectorAll('.size-chip').forEach((c) => c.classList.remove('active'));
  el.classList.add('active');
}

function toggleAcc(btn) {
  const item = btn.closest('.accordion-item');
  const panel = item.querySelector('.accordion-panel');
  const isOpen = item.classList.contains('open');

  item.parentElement.querySelectorAll('.accordion-item').forEach((i) => {
    i.classList.remove('open');
    i.querySelector('.accordion-panel').style.maxHeight = null;
  });
  if (!isOpen) {
    item.classList.add('open');
    panel.style.maxHeight = panel.scrollHeight + 'px';
  }
}

async function requestRepaint() {
  const p = PRODUCTS[currentProduct];
  if (!p) return;

  const name = prompt('Your name?');
  if (!name) return;
  const email = prompt('Your email?');
  if (!email) return;

  try {
    await api('POST', '/repaint', { slug: p.slug, name, email, size: selectedSize, note: '' });
    alert('Request received. We will be in touch about repainting this piece.');
  } catch (e) {
    alert(e.message);
  }
}
