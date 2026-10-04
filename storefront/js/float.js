/* ==========================================================================
   Float
   Zero gravity, all over the site: the photos and the cards they sit in,
   the icons, the buttons, chips and tags, and (barely) the headings drift a
   few pixels and rock a fraction of a degree, each on its own, like things
   floating in space.

   What stays still: paragraphs, forms, the site header and ticker, the
   bag, pop-ups and the enlarged photo view (reading, typing and getting
   around never wobble), and anything that already moves by itself: the
   home page film, the sky, the asteroid fields, the glitch layer and the
   layers that drift with the scroll (data-depth, editorial.js).

   Kept cheap, after measuring it:
   - each piece gets one animation of plain numbers (the Web Animations
     API), of `translate` and `rotate` only, which the graphics chip runs
     by itself; and because those aren't `transform`, the drift adds to the
     hover effects (buttons lifting, photos scaling up) instead of
     replacing them. (A CSS animation reading each piece's numbers from
     custom properties looked the same but made the browser restyle every
     floating piece from scratch whenever anything else on the page moved:
     ~10ms a frame on an ordinary laptop.)
   - an SVG icon never moves by itself: the browser hands an SVG's movement
     to the graphics chip only at exactly 100% zoom, which a phone, or a
     laptop with its screen scaled to 125%, never is, and it would then
     redraw the icon every frame. The icon floats in an ordinary box
     instead: its own little box if it has one, else a span wrapped round
     it that lays out just as the icon did (.fl-svg, float.css).
   - a box that clips what's in it, around things with layers of their own
     (the poster's words and cut-out, the product photo's tag), drifts but
     never tilts: tilting it would make the browser draw it offscreen every
     frame to keep its clipped edges straight. For the same reason a piece
     behind a clip inside a tilting one (a product card's One Of One tag)
     rides along with it instead of floating on its own.
   - pieces packed close together (the gallery walls) move less, so
     neighbours swinging opposite ways never slide over each other; the
     worlds row, its tiles 3px apart, moves as one.
   - only pieces on or near the screen move; the rest are paused where
     they are, so nothing jumps when they come back;
   - the page is looked over when it has a moment (requestIdleCallback),
     and again for anything added later (the shop's pieces, the gallery's
     photos); sizes are read only then, never while anything moves.
   With reduced motion nothing floats.

   To make something else float, add its selector to FLOAT_TARGETS, or give
   it data-float="photo" (or any other kind in FLOAT_KINDS); to keep
   something still, data-float="off". A new photo floats by itself, in its
   frame, unless it runs from one side of the screen to the other, or fills
   a card that also holds words (a title laid over the photo): it can't
   move inside that card without showing a strip of the card behind it, so
   give the card itself data-float="photo" and the lot floats together.
   ========================================================================== */

// How each kind floats: ranges for px sideways, px up and down, degrees of
// rock and seconds per drift. Each piece picks its own value in each.
const FLOAT_KINDS = {
  photo: { x: [2, 3], y: [4, 7], r: [0.25, 0.6], s: [7, 12] },
  sheet: { x: [1, 2], y: [3, 5], r: [0, 0], s: [9, 12] },          // clips layers of its own: drifts, never tilts
  cell: { x: [0.4, 0.8], y: [1.5, 2.5], r: [0, 0.15], s: [8, 12] }, // packed in a wall: two neighbours swinging opposite ways still clear an 8px gap
  row: { x: [0.3, 0.7], y: [3, 5], r: [0, 0.12], s: [8, 12] },     // a whole row of tiles moving as one
  icon: { x: [1.5, 2.5], y: [2.5, 4.5], r: [1, 2.5], s: [6, 10] },
  tag: { x: [1, 1.5], y: [1.5, 2.5], r: [0.4, 1], s: [6, 9] },
  button: { x: [0.8, 1.5], y: [1.5, 2.8], r: [0, 0.3], s: [7, 11] },
  heading: { x: [0.4, 1], y: [1.5, 2.5], r: [0, 0], s: [9, 12] },
};
const FLOAT_STEPS = 16;     // points along one drift: enough that the straight lines between them never show at a few px
const FLOAT_CORNER = 3;     // px: the most a corner may move by rocking, so a big photo rocks less than a small card
const FLOAT_EDGE = 8;       // px: this close to the side of the screen a piece only bobs, so it never pokes off the page
const FLOAT_ICON_MAX = 72;  // px: a picture or graphic no bigger than this floats as an icon

// The pieces of the site that float, as [selector, kind]. Containers come
// first: a photo or a label inside a card floats with the card.
const FLOAT_TARGETS = [
  ['.product-card, .story-visual, .anatomy-shot, .lookbook-main', 'photo'],
  ['.poster, .pdp-shot', 'sheet'],
  ['.gallery-tile, .log-card', 'cell'],
  ['.worlds-row', 'row'],
  ['.trust-block > svg, .trust-item > svg, .visit-row > svg, .channel-card .cic, .lookbook-mark svg, '
    + '.poster-note svg, .poster-mark svg, .poster-side .stars, .foot-social a, .wa-float, .fx-rail', 'icon'],
  ['.one-tag', 'tag'],
  ['.btn-primary, .btn-outline, .btn-oxblood, .link-plus, .icon-square, .filter-chip, .size-chip, .story-stats > div', 'button'],
  ['.section-head h2, main h1.display, main h2.display, .visit-strip h3', 'heading'],
];

// Never float these, or anything inside them.
const FLOAT_NEVER = [
  'header.site-nav', '.ticker', '.transmission', '.grain', '.film', '.galaxy', '.glitch-veil', '.glitch-copy',
  '.astro-field', '[data-field]', '[class*="asteroid"]',
  '[data-depth]', '.fx-bg', '.split-media', '.banner > img', '.poster-back', '.poster-tag', '.poster-figure',
  '.cart-drawer', '.cart-overlay', '.modal-overlay', 'dialog', 'form', '.summary',
  '[data-float="off"]',
].join(', ');

// Text and controls: a photo's frame never grows to take these in.
const FLOAT_FRAME_STOP = 'p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, dl, table, form, input, textarea, select, button';

// `root` itself, if it matches, and everything inside it that does.
function floatWithin(root, selector) {
  const inside = [...root.querySelectorAll(selector)];
  return root.matches && root.matches(selector) ? [root, ...inside] : inside;
}

// Whether a kind rocks at all.
const floatTilts = (kind) => FLOAT_KINDS[kind].r[1] > 0;

// Whether a box cuts off what's inside it at its edges.
function floatClips(el) {
  const s = getComputedStyle(el);
  return s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none';
}

// Whether something between `el` and `top` (`top` included) cuts it off.
function floatClippedWithin(el, top) {
  for (let a = el.parentElement; a; a = a.parentElement) {
    if (floatClips(a)) return true;
    if (a === top) break;
  }
  return false;
}

// A photo floats in the frame it sits in: the link, card or box around it,
// as far out as that holds just this one photo and no text. A plain inline
// box (a link run round a photo) can't be moved, so it's never the frame
// itself, though a box further out still can be.
function floatFrame(media) {
  let frame = media;
  for (let el = media.parentElement; el && el.tagName !== 'MAIN' && el !== document.body; el = el.parentElement) {
    if (el.matches('section, .wrap') || el.querySelectorAll('img, video').length > 1 || el.querySelector(FLOAT_FRAME_STOP)) break;
    const display = getComputedStyle(el).display;
    if (display !== 'inline' && display !== 'contents') frame = el;
  }
  return frame;
}

// Whether a photo (`box` its size and place) fills a box that also holds
// words: a card with its title laid over the photo, a hero with its heading
// over the backdrop. It can't move in there without showing a strip of
// the box behind it.
function floatFillsCard(frame, box) {
  const host = getComputedStyle(frame).position === 'absolute' ? frame.offsetParent : frame.parentElement;
  if (!host || host === document.body) return false;
  const around = host.getBoundingClientRect();
  if (box.width < around.width - 4 || box.height < around.height - 4) return false;
  return host.textContent.trim().length > frame.textContent.trim().length;
}

// The box an SVG icon floats in when it has one of its own: a box around
// nothing but the icon, no bigger than an icon (a pin, a badge, an
// icon-only button). Null when one has to be made (floatWrap).
function floatIconHost(svg) {
  const host = svg.parentElement;
  if (host.classList.contains('fl-svg')) return host;
  if (host.children.length !== 1 || host.textContent.trim()) return null;
  const display = getComputedStyle(host).display;
  if (display === 'inline' || display === 'contents') return null;
  const box = host.getBoundingClientRect();
  return box.width && box.width <= FLOAT_ICON_MAX && box.height <= FLOAT_ICON_MAX ? host : null;
}

// Wraps an SVG icon in a span to float in, laid out just as the icon was
// (.fl-svg in float.css: a block, or inline if the icon was). An icon
// pinned in place itself (absolute, fixed, sticky) is left alone: once
// the span moved, it would be pinned to the span instead.
function floatWrap(svg) {
  const own = getComputedStyle(svg);
  if (own.position !== 'static' && own.position !== 'relative') return null;
  const box = document.createElement('span');
  box.className = 'fl-svg';
  if (own.display.startsWith('inline')) {
    box.classList.add('is-inline');
    box.style.verticalAlign = own.verticalAlign;
  }
  svg.replaceWith(box);
  box.appendChild(svg);
  return box;
}

// One drift as keyframes: a slow figure of eight (one bob up and down while
// it sways out and back twice), rocking with the bob, starting and ending
// at rest. x and y in px, r in degrees, any of them negative.
function floatKeyframes(x, y, r) {
  return Array.from({ length: FLOAT_STEPS + 1 }, (_, i) => {
    const a = (i / FLOAT_STEPS) * Math.PI * 2;
    const dx = (x * Math.sin(2 * a)).toFixed(2);
    const dy = (y * Math.sin(a)).toFixed(2);
    const tilt = (r * Math.sin(a)).toFixed(3);
    return r ? { translate: `${dx}px ${dy}px`, rotate: `${tilt}deg` } : { translate: `${dx}px ${dy}px` };
  });
}

function initFloat() {
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (calm.matches || !('IntersectionObserver' in window) || !Element.prototype.animate) return;
  if (!window.CSS || !CSS.supports('translate', '1px')) return;

  const floating = new Map(); // element -> { kind, seed, shape, keyframes, duration, anim }
  let vh = window.innerHeight;
  const later = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 800 }) : setTimeout(fn, 60));

  /* ---- moving near the screen, paused away from it ---- */
  // A piece moves only while it's on the screen (or just about to be):
  // every moving piece costs the browser a little each frame. Off it, it's
  // paused where it is, so nothing jumps when it comes back.
  const near = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const f = floating.get(e.target);
      if (!f) continue;
      if (!e.isIntersecting) { if (f.anim) f.anim.pause(); continue; }
      if (f.anim) { f.anim.play(); continue; }
      f.anim = e.target.animate(f.keyframes, { duration: f.duration, iterations: Infinity, easing: 'linear' });
      // In view already (the page has just opened): start from rest, or it
      // would jump. Coming up from off the screen: start anywhere along
      // the drift, so neighbours are never in step.
      const box = e.boundingClientRect;
      if (box.bottom <= 0 || box.top >= vh) f.anim.currentTime = Math.random() * f.duration;
    }
  }, { rootMargin: '10% 0px' });

  /* ---- each piece's own drift ---- */
  // Sizes and positions are all read first and the numbers all worked out
  // after, so the browser works the page out once, not once per piece.
  function tune(list) {
    const width = document.documentElement.clientWidth;
    const boxes = list.map((el) => el.getBoundingClientRect());
    const pick = (range, s) => range[0] + s * (range[1] - range[0]);
    const sign = (s) => (s < 0.5 ? -1 : 1);
    list.forEach((el, i) => {
      const f = floating.get(el);
      const k = FLOAT_KINDS[f.kind];
      const box = boxes[i];
      const edge = box.width > 0 && (box.left < FLOAT_EDGE || box.right > width - FLOAT_EDGE);
      const half = Math.hypot(box.width, box.height) / 2;
      const most = half ? (FLOAT_CORNER / half) * (180 / Math.PI) : Infinity;
      const x = edge ? 0 : pick(k.x, f.seed[0]) * sign(f.seed[4]);
      const y = pick(k.y, f.seed[1]) * sign(f.seed[5]);
      const r = edge ? 0 : Math.min(pick(k.r, f.seed[2]), most) * sign(f.seed[6]);
      const shape = `${x.toFixed(2)} ${y.toFixed(2)} ${r.toFixed(2)}`;
      if (shape === f.shape) return; // unchanged: leave a running drift alone
      f.shape = shape;
      f.duration = pick(k.s, f.seed[3]) * 1000;
      f.keyframes = floatKeyframes(x, y, Math.abs(r) < 0.01 ? 0 : r);
      if (f.anim) f.anim.effect.setKeyframes(f.keyframes);
    });
  }

  // Lets go of a piece: it settles at rest and stops being watched.
  function release(el) {
    const f = floating.get(el);
    if (!f) return;
    near.unobserve(el);
    if (f.anim) f.anim.cancel();
    floating.delete(el);
    el.classList.remove('fl');
  }

  // Whether `el` sits behind a clip inside a piece that tilts (a tag in a
  // product card's photo box): it rides along with that piece instead.
  function ridesAlong(el) {
    const up = el.parentElement;
    if (!up || !up.closest('.fl')) return false;
    let clipped = false;
    for (let a = up; a && a !== document.body; a = a.parentElement) {
      if (!clipped && floatClips(a)) clipped = true;
      const f = floating.get(a);
      if (clipped && f && floatTilts(f.kind)) return true;
    }
    return false;
  }

  // Takes `el` on, unless it's somewhere nothing floats, rides along with
  // a tilting piece, can't be moved (a plain inline box) or already moves
  // by its own means (an animation of its own, or a script setting its
  // `translate` or `rotate`). `found` marks one turned up by the
  // catch-all, which also leaves alone anything pinned in place, and a box
  // whose positioned parts would shift if it became their frame (as a
  // moving element does).
  function adopt(el, kind, found) {
    if (floating.has(el) || el.closest(FLOAT_NEVER) || ridesAlong(el)) return false;
    const style = getComputedStyle(el);
    if (style.animationName !== 'none' || style.translate !== 'none' || style.rotate !== 'none') return false;
    if (style.display === 'contents' || (style.display === 'inline' && !el.matches('img, video, canvas, iframe, embed, object'))) return false;
    if (found) {
      if (style.position === 'fixed' || style.position === 'sticky') return false;
      if (style.position === 'static' && [...el.children].some((c) => getComputedStyle(c).position === 'absolute')) return false;
    }
    // A tilting piece takes along whatever already floats inside it
    // behind a clip (the same rule as ridesAlong, from the other side).
    if (floatTilts(kind)) {
      for (const inner of el.querySelectorAll('.fl')) if (floatClippedWithin(inner, el)) release(inner);
    }
    floating.set(el, { kind, seed: Array.from({ length: 7 }, Math.random), shape: '', keyframes: null, duration: 9000, anim: null });
    el.dataset.float = kind;
    el.classList.add('fl');
    return true;
  }

  // Looks over `root` (the page, or something just added to it) for what
  // floats, and starts watching it.
  function scan(root) {
    const added = [];
    // SVG icons are put in their boxes last, once everything has been
    // measured: wrapping one changes the page, and measuring after each
    // change would have the browser lay the page out again every time.
    const icons = new Map(); // svg -> [kind, found]
    const take = (el, kind, found) => {
      if (el instanceof SVGElement) { if (!icons.has(el)) icons.set(el, [kind, found]); return; }
      if (adopt(el, kind, found)) added.push(el);
    };

    for (const [selector, kind] of FLOAT_TARGETS) {
      for (const el of floatWithin(root, selector)) take(el, kind, false);
    }
    for (const el of floatWithin(root, '[data-float]:not([data-float="off"])')) {
      take(el, FLOAT_KINDS[el.dataset.float] ? el.dataset.float : 'photo', false);
    }

    // The catch-all, for sections added since the list above was written:
    // photos (in their frames) and small icons anywhere in the page.
    const width = document.documentElement.clientWidth;
    for (const media of floatWithin(root, 'main img, main video, main svg')) {
      if (media.ownerSVGElement || media.parentElement.closest('[data-float]') || media.closest(FLOAT_NEVER)) continue;
      const svg = media instanceof SVGElement;
      const frame = svg ? media : floatFrame(media);
      if (floating.has(frame) || icons.has(frame)) continue;
      const box = frame.getBoundingClientRect();
      if (!box.width || !box.height) continue;                     // hidden, or not laid out yet
      const small = box.width <= FLOAT_ICON_MAX && box.height <= FLOAT_ICON_MAX;
      if (svg && !small) continue;                                 // big graphics are backdrops or art
      if (!small && box.left < FLOAT_EDGE && box.right > width - FLOAT_EDGE) continue; // runs edge to edge: a backdrop
      if (!small && floatFillsCard(frame, box)) continue;          // the card should float instead (see the top)
      take(frame, small ? 'icon' : 'photo', true);
    }

    // The icons: first where each one floats (its own box, or one to be
    // made), all read before anything is changed; then the boxes made.
    const plan = [];
    for (const [svg, [kind, found]] of icons) {
      if (svg.ownerSVGElement || !svg.parentElement || svg.closest(FLOAT_NEVER) || ridesAlong(svg)) continue;
      plan.push([svg, floatIconHost(svg), kind, found]);
    }
    let wrapped = false;
    for (const [svg, host, kind, found] of plan) {
      let box = host;
      if (!box) {
        box = floatWrap(svg);
        if (!box) continue;
        wrapped = true;
      }
      take(box, kind, found);
    }
    if (wrapped) watcher.takeRecords(); // our own wrapping isn't news to the watcher below

    const fresh = added.filter((el) => floating.has(el)); // less any taken along by a tilting piece since
    if (!fresh.length) return;
    tune(fresh);
    for (const el of fresh) near.observe(el);
  }

  // Lets go of every piece in a part taken out of the page.
  function forget(root) {
    for (const el of floatWithin(root, '.fl')) release(el);
  }

  /* ---- what's added and taken away later ---- */
  // The shop's pieces arrive from the server, and the gallery's photos
  // from its list, after the page opens: whatever is added is looked over
  // in a batch when the page has a moment. Additions inside places nothing
  // floats are skipped straight away, as are the glitch's copies of
  // headings, which come and go all the time.
  let pending = new Set();
  let queued = false;
  const flush = () => {
    queued = false;
    const roots = [...pending].filter((el) => el.isConnected);
    pending = new Set();
    for (const root of roots) scan(root);
  };
  const watcher = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.target.nodeType !== 1 || rec.target.closest(FLOAT_NEVER)) continue;
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1 && !node.classList.contains('glitch-copy')) pending.add(node);
      }
      for (const node of rec.removedNodes) {
        if (node.nodeType === 1 && !node.isConnected && !node.classList.contains('glitch-copy')) forget(node);
      }
    }
    if (pending.size && !queued) { queued = true; later(flush); }
  });
  watcher.observe(document.body, { childList: true, subtree: true });

  // A new screen width can bring a piece up against the edge of the
  // screen, or away from it: work the numbers out again once the resizing
  // stops. (Only the width: a phone's address bar sliding away changes the
  // height all the time while scrolling.)
  let resizing = 0;
  let wide = window.innerWidth;
  const onResize = () => {
    vh = window.innerHeight;
    if (window.innerWidth === wide) return;
    wide = window.innerWidth;
    clearTimeout(resizing);
    resizing = setTimeout(() => later(() => tune([...floating.keys()].filter((el) => el.isConnected))), 250);
  };
  window.addEventListener('resize', onResize);

  // Reduced motion switched on with the page open: everything settles.
  calm.addEventListener('change', () => {
    if (!calm.matches) return;
    watcher.disconnect();
    near.disconnect();
    window.removeEventListener('resize', onResize);
    forget(document.body);
  });

  later(() => scan(document.body));
}
