/* ==========================================================================
   Gallery
   The YnR multiverse: photos and Reels from @ynr_multiverse, made web-ready
   by server/scripts/gallery-build.js, which also writes the list this reads
   (/assets/gallery/gallery.json, newest first).

   - On /gallery: the lot in a masonry grid, filterable by group
     (/gallery?group=painted links straight to one), each opening larger in
     an enlarged view you can step through with the arrow keys or a swipe.
     Videos have no sound (see the build script) and loop.
   - Anywhere else, a strip of the latest few photos, linking through:
       <div class="gallery-strip" data-count="6" data-group="shop"></div>
     or a wall of one group's photos that open in the same enlarged view:
       <div class="gallery-wall" data-group="painted" data-count="40"></div>
   ========================================================================== */

const GALLERY_GROUPS = {
  all: 'All',
  alien: 'Alien Invasion',
  painted: 'Hand-painted',
  crew: 'The crew',
  shop: 'The shop',
  events: 'Events',
  reels: 'Reels',
};
const GALLERY_DIR = '/assets/gallery/';

let galleryList = null;
function loadGallery() {
  galleryList = galleryList || fetch(`${GALLERY_DIR}gallery.json`)
    .then((res) => { if (!res.ok) throw new Error(`gallery ${res.status}`); return res.json(); });
  return galleryList;
}

const galleryThumb = (item) => `${GALLERY_DIR}${item.id}${item.type === 'video' ? '-poster' : ''}-800.webp`;
const galleryLabel = (item) => item.caption || GALLERY_GROUPS[item.group];

function galleryTile(item, index) {
  const video = item.type === 'video';
  return `<button class="gallery-tile${video ? ' is-video' : ''}" type="button" data-index="${index}"
      aria-label="${escapeHtml(`${video ? 'Play video' : 'Open photo'}: ${galleryLabel(item)}`)}">
    <img src="${galleryThumb(item)}" width="${item.w}" height="${item.h}" loading="lazy" decoding="async" alt="">
    ${video ? `<span class="tile-play" aria-hidden="true">&#9654; ${item.dur ? `0:${String(item.dur).padStart(2, '0')}` : ''}</span>` : ''}
  </button>`;
}

/* ---------------- the enlarged view ---------------- */

// /gallery has it in its markup; other pages with a wall get it added.
const LIGHTBOX_HTML = `<dialog class="lightbox" id="lightbox" aria-label="Enlarged view">
  <button class="lightbox-close" type="button" aria-label="Close">&times;</button>
  <button class="lightbox-step prev" type="button" aria-label="Previous">&#8592;</button>
  <figure class="lightbox-figure">
    <div class="lightbox-media" id="lightboxMedia"></div>
    <figcaption class="lightbox-caption">
      <span id="lightboxText"></span>
      <span class="lightbox-meta"><span id="lightboxCount"></span><a id="lightboxPost" target="_blank" rel="noopener">View on Instagram &nearr;</a></span>
    </figcaption>
  </figure>
  <button class="lightbox-step next" type="button" aria-label="Next">&#8594;</button>
</dialog>`;

// One per page, however many grids and walls open it.
let lightboxOpen = null;
function galleryLightbox() {
  if (lightboxOpen) return lightboxOpen;
  if (!document.getElementById('lightbox')) document.body.insertAdjacentHTML('beforeend', LIGHTBOX_HTML);
  const box = document.getElementById('lightbox');
  const media = document.getElementById('lightboxMedia');
  const text = document.getElementById('lightboxText');
  const count = document.getElementById('lightboxCount');
  const post = document.getElementById('lightboxPost');
  let list = [];
  let at = 0;

  function show(i) {
    at = (i + list.length) % list.length;
    const item = list[at];
    const alt = escapeHtml(`${GALLERY_GROUPS[item.group]}: ${galleryLabel(item)}`);
    media.innerHTML = item.type === 'video'
      ? `<video src="${GALLERY_DIR}${item.id}.mp4" poster="${GALLERY_DIR}${item.id}-poster-1280.webp" width="${item.w}" height="${item.h}" autoplay muted loop playsinline controls aria-label="${alt}"></video>`
      : `<img src="${GALLERY_DIR}${item.id}-1280.webp" width="${item.w}" height="${item.h}" alt="${alt}">`;
    text.textContent = galleryLabel(item);
    count.textContent = `${at + 1} / ${list.length}`;
    post.hidden = !item.post;
    if (item.post) post.href = `https://www.instagram.com/p/${item.post}/`;
  }

  box.querySelector('.prev').addEventListener('click', () => show(at - 1));
  box.querySelector('.next').addEventListener('click', () => show(at + 1));
  box.querySelector('.lightbox-close').addEventListener('click', () => box.close());
  // A click on the dark surround (the dialog itself, not what's in it) closes.
  box.addEventListener('click', (e) => { if (e.target === box) box.close(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
  let touchX = null;
  box.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1));
    touchX = null;
  });
  // Stop a video playing on after the view closes.
  box.addEventListener('close', () => { media.innerHTML = ''; });

  lightboxOpen = (items, i) => { list = items; show(i); box.showModal(); };
  return lightboxOpen;
}

/* ---------------- /gallery ---------------- */

function renderGallery(items) {
  const grid = document.getElementById('galleryGrid');
  const filters = document.getElementById('galleryFilters');
  const open = galleryLightbox();
  const present = ['all', ...Object.keys(GALLERY_GROUPS).filter((g) => g !== 'all' && items.some((i) => i.group === g))];
  const asked = new URLSearchParams(location.search).get('group');
  let group = present.includes(asked) ? asked : 'all';
  let shown = [];

  function draw() {
    shown = group === 'all' ? items : items.filter((i) => i.group === group);
    grid.innerHTML = shown.map(galleryTile).join('');
    filters.innerHTML = present.map((g) =>
      `<button class="filter-chip${g === group ? ' active' : ''}" type="button" data-group="${g}" aria-pressed="${g === group}">${GALLERY_GROUPS[g]}</button>`).join('');
  }

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-group]');
    if (!chip) return;
    group = chip.dataset.group;
    const url = new URL(location.href);
    if (group === 'all') url.searchParams.delete('group');
    else url.searchParams.set('group', group);
    history.replaceState(null, '', url);
    draw();
  });
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.gallery-tile');
    if (tile) open(shown, Number(tile.dataset.index));
  });
  draw();
}

/* ---------------- strips on other pages ---------------- */

// The photos for a strip: the newest of one group, or with no group a mix,
// the newest from each group in turn, so a single shoot doesn't fill the row.
function stripPhotos(items, group, count) {
  const photos = items.filter((i) => i.type === 'photo' && (!group || i.group === group));
  if (group) return photos.slice(0, count);
  const groups = Object.keys(GALLERY_GROUPS).map((g) => photos.filter((i) => i.group === g)).filter((l) => l.length);
  const out = [];
  for (let round = 0; out.length < count && groups.some((l) => l[round]); round++) {
    for (const list of groups) if (list[round] && out.length < count) out.push(list[round]);
  }
  return out;
}

function renderStrips(items) {
  for (const strip of document.querySelectorAll('.gallery-strip')) {
    const group = strip.dataset.group;
    const photos = stripPhotos(items, group, Number(strip.dataset.count) || 6);
    const link = `/gallery${group ? `?group=${group}` : ''}`;
    strip.innerHTML = photos.map((item) => `<a class="gallery-tile" href="${link}" aria-label="${escapeHtml(`See it in the gallery: ${galleryLabel(item)}`)}">
      <img src="${galleryThumb(item)}" width="${item.w}" height="${item.h}" loading="lazy" decoding="async" alt=""></a>`).join('');
  }
}

// A group's photos, opening in the enlarged view.
function renderWalls(items) {
  for (const wall of document.querySelectorAll('.gallery-wall')) {
    const group = wall.dataset.group;
    const photos = items
      .filter((i) => i.type === 'photo' && (!group || i.group === group))
      .slice(0, Number(wall.dataset.count) || 60);
    wall.innerHTML = photos.map(galleryTile).join('');
    wall.addEventListener('click', (e) => {
      const tile = e.target.closest('.gallery-tile');
      if (tile) galleryLightbox()(photos, Number(tile.dataset.index));
    });
  }
}

function initGallery() {
  const grid = document.getElementById('galleryGrid');
  const strips = document.querySelector('.gallery-strip');
  const walls = document.querySelector('.gallery-wall');
  if (!grid && !strips && !walls) return;
  loadGallery()
    .then((items) => {
      if (grid) renderGallery(items);
      if (strips) renderStrips(items);
      if (walls) renderWalls(items);
    })
    .catch(() => {
      const sorry = '<p class="load-msg">The gallery didn\'t load. See it all on <a href="https://www.instagram.com/ynr_multiverse/" target="_blank" rel="noopener">Instagram</a>.</p>';
      if (grid) grid.innerHTML = sorry;
      document.querySelectorAll('.gallery-wall').forEach((wall) => { wall.innerHTML = sorry; });
    });
}
