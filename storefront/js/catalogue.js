/* ==========================================================================
   Catalogue
   The shop grid, its category filters, and the product page. Nothing about
   the pieces is hardcoded here: it all comes from the API, so the owner can
   add, price and retire pieces from the admin panel without editing code.
   ========================================================================== */

let PRODUCTS = {};        // slug -> product
let SHOP_ORDER = [];      // display order, as returned by the API
let ZONES = [];           // delivery zones
let currentProduct = null;
let selectedSize = null;

const productUrl = (slug) => '/product?p=' + encodeURIComponent(slug);
const categorySlug = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------- grid ---------------- */
// A real link, so a piece can be opened in a new tab or shared as a URL.
function productCard(p) {
  const sold = p.isSold;
  const tag = sold ? 'Sold — Repaint' : (p.isReserved ? 'Reserved' : 'One Of One');
  return `
  <a class="product-card ${sold ? 'is-sold' : ''}" href="${productUrl(p.slug)}">
    <div class="product-media">
      <div class="one-tag ${sold ? 'sold-badge' : ''}">${tag}</div>
      <img src="${imgUrl(p.image)}" alt="${escapeAttr(p.name)}, hand-painted by YnR" loading="lazy">
      <div class="quick-add">${sold ? 'Ask For A Repaint' : 'View &amp; Order'}</div>
    </div>
    <div class="product-info">
      <div><h4>${escapeHtml(p.name)}</h4><div class="pmeta">${escapeHtml(p.category)}</div></div>
      <div class="price">${escapeHtml(p.priceLabel)}</div>
    </div>
  </a>`;
}

function renderGrid(target, list) {
  if (!target) return;
  target.innerHTML = list.length
    ? list.map(productCard).join('')
    : '<div class="load-msg">Nothing in this category right now — new pieces are always being painted.</div>';
}

/* `limit` shows the first N pieces still for sale (the home page);
   `filters` names the element to build category buttons in (the shop). */
async function loadCatalogue({ grid: gridId, limit = 0, filters = null } = {}) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = Array.from({ length: limit || 6 }, () => '<div class="skeleton"></div>').join('');

  try {
    const data = await api('GET', '/products');
    PRODUCTS = {};
    SHOP_ORDER = [];
    data.products.forEach((p) => { PRODUCTS[p.slug] = p; SHOP_ORDER.push(p.slug); });

    if (filters) {
      renderFilters(document.getElementById(filters), grid, data.products);
    } else if (limit) {
      const forSale = data.products.filter((p) => !p.isSold);
      renderGrid(grid, (forSale.length ? forSale : data.products).slice(0, limit));
    } else {
      renderGrid(grid, data.products);
    }
  } catch (e) {
    grid.innerHTML = `<div class="load-msg">${escapeHtml(e.message)}
      <br><br><button class="btn-outline" onclick="location.reload()">Try again</button></div>`;
  }
}

/* Category buttons for the shop page. The choice is kept in the URL
   (/shop?category=tees) so a filtered view can be shared or bookmarked. */
function renderFilters(host, grid, products) {
  if (!host) { renderGrid(grid, products); return; }
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const wanted = new URLSearchParams(location.search).get('category') || '';
  let active = categories.find((c) => categorySlug(c) === wanted) || '';

  const draw = () => {
    host.innerHTML = ['', ...categories].map((c) =>
      `<button type="button" class="filter-chip${c === active ? ' active' : ''}" data-cat="${escapeAttr(c)}"
               aria-pressed="${c === active}">${c ? escapeHtml(c) : 'All'}</button>`).join('');
    renderGrid(grid, active ? products.filter((p) => p.category === active) : products);
  };

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    active = btn.dataset.cat;
    const url = new URL(location.href);
    if (active) url.searchParams.set('category', categorySlug(active));
    else url.searchParams.delete('category');
    history.replaceState(null, '', url);
    draw();
  });

  host.hidden = categories.length < 2;   // nothing to filter between
  draw();
}

async function loadZones() {
  try {
    ZONES = (await api('GET', '/delivery-zones')).zones;
  } catch (e) {
    ZONES = [];
  }
}

/* ---------------- product page ---------------- */
function loadProductPage() {
  const slug = new URLSearchParams(location.search).get('p');
  if (!slug) { location.replace('/shop'); return; }
  openProduct(slug);
}

async function openProduct(slug) {
  try {
    const data = await api('GET', '/products/' + encodeURIComponent(slug));
    const p = data.product;
    PRODUCTS[p.slug] = p;
    currentProduct = p.slug;
    selectedSize = (p.sizes && p.sizes[0]) || '';
    track('product_view', { slug: p.slug });

    document.title = `${p.name} — YnR`;
    document.getElementById('pdpEyebrow').textContent = 'Hand-Painted · ' + p.category;
    document.getElementById('pdpName').textContent = p.name;
    document.getElementById('pdpCrumbName').textContent = p.name;
    const crumb = document.getElementById('pdpCategory');
    crumb.textContent = p.category;
    crumb.href = '/shop?category=' + encodeURIComponent(categorySlug(p.category));
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
    document.title = 'Piece unavailable — YnR';
    document.getElementById('pdpName').textContent = 'Piece unavailable';
    document.getElementById('pdpDesc').textContent = e.message;
    document.querySelector('.pdp-actions').innerHTML =
      '<a class="btn-outline" href="/shop">Back To The Shop</a>';
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
