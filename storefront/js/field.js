/* ==========================================================================
   Field
   The asteroid field: photos from @ynr_multiverse floating in space, which
   the page flies you through as you scroll (styles in css/field.css).

   - Each photo drifts and turns slowly on its own, out on a ring around
     the flight path, so they sweep past the sides and never straight into
     you.
   - Depth: far ones are small, dim and soft (a 48px blurred copy made by
     server/scripts/gallery-fx.js, never a blur done by the browser); as one
     comes close, the real photo takes its place.
   - Pointed at (or tabbed to), a photo comes forward. Clicked or tapped, it
     flies to the front and stays there, with notes pinned round it like
     the jacket on the home page, while the field carries on behind it.
     Clicked or tapped again (or Escape) it slowly falls back to wherever
     its place in the field has got to.
   - With reduced motion there's no flying: the same photos sit still in a
     wall that opens them in the enlarged view (gallery.js).

   The page writes the section; this builds everything inside the .astro-field:
     <div class="astro-field" data-field data-groups="crew,events" data-label="The gang"></div>
   data-groups: which gallery groups (all of them if left out); data-videos:
   the Reels too; data-filters: chips to show one group, which also follow
   /gallery?group=alien links.

   Cheap by design. The scroll position is read in the scroll event; a
   frame only moves and fades (transform, opacity) the thirty or so photos
   in view, and nothing runs while the page is still. The drifting is CSS
   animation, which the graphics chip plays by itself; only photos in view
   have one, and none do while the field is off screen.
   ========================================================================== */

// Depth is measured in "near distances": a photo 1 away shows at half its
// full size, 0 away at full size, 3 away at a quarter.
const FIELD_FAR = 6;          // where photos first appear, faint and small
const FIELD_NEAR = -0.45;     // past full size: by here one has gone by
const FIELD_SHARP = 2.4;      // closer than this, the real photo replaces the soft
                              // one (early, so it has time to arrive)
const FIELD_MAX = 30;         // the most photos in view at once
const FIELD_RUN = 38;         // svh of scrolling to fly one near distance
const FIELD_HOVER_MS = 420;   // coming forward when pointed at, and going back
const FIELD_RISE_MS = 700;    // flying to the front when picked
const FIELD_FALL_MS = 1500;   // falling back when let go
const FIELD_DRIFTS = 4;       // drift animations in field.css (field-drift-0 to 3)
// The same four drifts, as [x %, y %, degrees] at their start and end. A
// photo flying to the front or back works out where its drift has got to
// from these, rather than asking the browser (which would stall a frame).
// Keep in step with the keyframes in field.css.
const FIELD_DRIFT_KEYS = [
  [[-3, 2, -4], [4, -3, 3]],
  [[3, 3, 5], [-2, -4, -2]],
  [[-4, -2, 2], [2, 4, -5]],
  [[2, -3, -6], [-3, 2, 1]],
];
const FIELD_STILL = { x: 0, y: 0, r: 0 };

const fieldClamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const fieldEase = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fieldOut = (t) => 1 - Math.pow(1 - t, 4);
const fieldTiny = (item) => `${GALLERY_DIR}fx/tiny/${item.id}.webp`;
const fieldBig = (item) => `${GALLERY_DIR}${item.id}${item.type === 'video' ? '-poster' : ''}-1280.webp`;
// 2026-09-29 -> 29.09.26
const fieldDate = (date) => String(date || '').split('-').reverse().map((part, i) => (i === 2 ? part.slice(2) : part)).join('.');

// The same photo gets the same spot in the field on every visit: random
// numbers seeded from its id.
function fieldRandom(text) {
  let s = 2166136261;
  for (let i = 0; i < text.length; i++) s = Math.imul(s ^ text.charCodeAt(i), 16777619);
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// CSS's ease-in-out (cubic-bezier(.42, 0, .58, 1)), which the drifts use:
// find where along the curve t falls, then how far along it has eased.
function fieldInOut(t) {
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 14; i++) {
    const x = 3 * (1 - u) * (1 - u) * u * 0.42 + 3 * (1 - u) * u * u * 0.58 + u * u * u;
    if (x < t) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return 3 * (1 - u) * u * u + u * u * u;
}

// Where a photo's drift has got to at a frame's time: its animation began
// when the photo came into view (r.driftAt), already r.driftLead seconds in,
// and swings to and fro every r.driftDur seconds.
function fieldDriftAt(r, now) {
  const n = ((now - r.driftAt) / 1000 + r.driftLead) / r.driftDur;
  const k = Math.floor(n);
  const e = fieldInOut(k % 2 ? 1 - (n - k) : n - k);
  const [a, b] = FIELD_DRIFT_KEYS[r.driftN];
  return { x: a[0] + (b[0] - a[0]) * e, y: a[1] + (b[1] - a[1]) * e, r: a[2] + (b[2] - a[2]) * e };
}

// A Reel let go of: stop it and free its player and what it had loaded
// straight away, rather than whenever the browser gets round to it.
function fieldStopVideo(root) {
  const video = root.querySelector('video');
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
}

// Swap a picture for a bigger one only once that's fetched and decoded
// (off the main thread), so the swap never holds up a frame.
function fieldSwap(img, src) {
  img.dataset.want = src;
  const next = new Image();
  next.decoding = 'async';
  next.src = src;
  const show = () => { if (img.dataset.want === src) img.src = src; };
  (next.decode ? next.decode() : Promise.resolve()).then(show, () => {});
}

function fieldChips(field) {
  return field.present.map((g) => `<button class="filter-chip${g === field.group ? ' active' : ''}" type="button" data-group="${g}" aria-pressed="${g === field.group}">${GALLERY_GROUPS[g]}</button>`).join('');
}

// A chip picked: remember it, and put it in the address so the link can be
// shared (or come back to) showing that group.
function fieldPick(field, row, group) {
  field.group = group;
  for (const chip of row.querySelectorAll('[data-group]')) {
    const on = chip.dataset.group === group;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
  }
  const url = new URL(location.href);
  if (group === 'all') url.searchParams.delete('group');
  else url.searchParams.set('group', group);
  history.replaceState(null, '', url);
}

const fieldShown = (field) => (field.group === 'all' ? field.pool : field.pool.filter((i) => i.group === field.group));

function initField() {
  const fields = [...document.querySelectorAll('[data-field]')];
  if (!fields.length) return;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
  loadGallery()
    .then((items) => fields.forEach((el) => idle(() => buildField(el, items), { timeout: 900 })))
    .catch(() => fields.forEach((el) => {
      el.innerHTML = '<p class="load-msg">The photos didn\'t load. See them all on <a href="https://www.instagram.com/ynr_multiverse/" target="_blank" rel="noopener">Instagram</a>.</p>';
    }));
}

function buildField(el, items) {
  const groups = el.dataset.groups ? el.dataset.groups.split(',').map((g) => g.trim()).filter(Boolean) : null;
  const videos = 'videos' in el.dataset;
  const pool = items.filter((i) => (videos || i.type === 'photo') && (!groups || groups.includes(i.group)));
  if (!pool.length) return;
  const present = Object.keys(GALLERY_GROUPS).filter((g) => g !== 'all' && pool.some((i) => i.group === g));
  const field = {
    el,
    pool,
    label: el.dataset.label || 'Photos',
    // chips only when there's more than one group to choose between
    filters: 'filters' in el.dataset && present.length > 1,
    present: ['all', ...present],
    group: 'all',
  };
  if (field.filters) {
    const asked = new URLSearchParams(location.search).get('group');
    if (present.includes(asked)) field.group = asked;
  }
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window);
  if (still) stillField(field);
  else flyField(field);
}

/* ---------------- reduced motion: a still wall ---------------- */

function stillField(field) {
  const { el } = field;
  el.classList.add('is-still');
  el.innerHTML = `<div class="wrap">
    ${field.filters ? `<div class="filter-row" role="group" aria-label="Show">${fieldChips(field)}</div>` : ''}
    <div class="gallery-grid"></div>
  </div>`;
  const row = el.querySelector('.filter-row');
  const grid = el.querySelector('.gallery-grid');
  let shown = [];
  const draw = () => {
    shown = fieldShown(field);
    grid.innerHTML = shown.map(galleryTile).join('');
  };
  if (row) {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-group]');
      if (!chip) return;
      fieldPick(field, row, chip.dataset.group);
      draw();
    });
  }
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.gallery-tile');
    if (tile) galleryLightbox()(shown, Number(tile.dataset.index));
  });
  draw();
}

/* ---------------- the flight ---------------- */

function flyField(field) {
  const { el } = field;
  const header = document.querySelector('header.site-nav');
  const canPoint = window.matchMedia('(hover: hover)').matches;
  // the width at which the notes move from beside the photo onto it, as
  // they do on the home page's jacket (store.css, "anatomy")
  const narrow = window.matchMedia('(max-width: 1180px)');
  const label = escapeHtml(field.label);

  el.classList.add('is-flying');
  // somewhere for keyboard focus to go that is never hidden, when a held
  // photo is put back because the field has scrolled away
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="visually-hidden">
      <h3>${label}: every photo</h3>
      <ul class="field-list"></ul>
    </div>
    <div class="field-stage is-away">
      <div class="field-space" role="group" tabindex="-1" aria-label="${label}: photos floating past as you scroll. Pick one to hold it at the front."></div>
      <div class="field-scrim" aria-hidden="true"></div>
      ${field.filters ? `<div class="field-chips" role="group" aria-label="Show">${fieldChips(field)}</div>` : ''}
      <p class="field-hint" aria-hidden="true">Scroll to fly through<span>${canPoint ? 'Point at a photo to pull it close. Click to hold it.' : 'Tap a photo to hold it.'}</span></p>
      <div class="field-meter" aria-hidden="true"><i></i></div>
      <p class="visually-hidden" aria-live="polite"></p>
    </div>`;
  const stage = el.querySelector('.field-stage');
  const space = stage.querySelector('.field-space');
  const scrim = stage.querySelector('.field-scrim');
  const chips = stage.querySelector('.field-chips');
  const hint = stage.querySelector('.field-hint');
  const meter = stage.querySelector('.field-meter i');
  const live = stage.querySelector('[aria-live]');
  const list = el.querySelector('.field-list');

  let rocks = [];
  let W = 0;                 // the stage's size
  let H = 0;
  let navH = -1;             // the header's height: the stage pins just under it
  let top = 0;               // where the field starts on the page
  let run = 1;               // px of scrolling while the stage is pinned
  let camFrom = 0;           // where the camera starts and ends, in depth
  let camTo = 1;
  let y = window.scrollY;
  let near = false;
  let queued = false;
  let held = null;           // the photo at the front (or on its way there)
  const shots = [];          // photos flying to the front or falling back
  let hintGone = false;
  let lastP = -1;
  let tap = null;            // where the last press started, to tell a tap from a scroll
  let sizedH = 0;            // the stage height the photos were last sized for
  let lastScroll = -1e9;
  // Photos sliding under a pointer held still while the page scrolls
  // aren't being pointed at; only the pointer moving onto one counts.
  const scrolling = () => performance.now() - lastScroll < 200;

  /* ---- the photos ---- */

  function populate() {
    const shown = fieldShown(field);
    const n = shown.length;
    // a short field spreads its few photos deeper, so it still has depth
    const gap = Math.max(0.25, 5.5 / n);
    rocks = shown.map((item, i) => {
      const rnd = fieldRandom(item.id);
      // the golden angle round the ring, so neighbours never bunch up
      const angle = i * 2.39996 + (rnd() - 0.5) * 0.9;
      const ring = 0.48 + rnd() * 0.62;
      const z = (i + rnd() * 0.7) * gap;
      const turn = (rnd() - 0.5) * 22;
      const driftN = Math.floor(rnd() * FIELD_DRIFTS);
      const driftDur = Number((16 + rnd() * 14).toFixed(1));
      const driftLead = Number((rnd() * 30).toFixed(1));
      // how far it can turn either way, its own tilt plus the drift's, for
      // working out the most room it can take up on screen
      const tilt = ((Math.abs(turn) + 6) * Math.PI) / 180;
      return {
        item,
        i,
        z,
        ax: Math.cos(angle) * ring,
        ay: Math.sin(angle) * ring,
        py: 0,               // ay, nudged off the middle if need be (size())
        turn,
        cos: Math.cos(tilt),
        sin: Math.sin(tilt),
        drift: `field-drift-${driftN} ${driftDur}s ease-in-out -${driftLead}s infinite alternate`,
        driftN, driftDur, driftLead, driftAt: 0,
        w: 0, h: 0, el: null, img: null,
        off: true, inFrame: false, sharp: false, held: false, pointed: false, focused: false,
        hover: 0, hoverFrom: 0, hoverTo: 0, hoverAt: 0,
        x: 0, y: 0, s: 0, rot: 0, light: 0,
      };
    });
    // starting with the nearest photo a little way off; ending with the
    // last few still ahead
    camFrom = -0.6;
    camTo = Math.max(camFrom + 1, rocks[n - 1].z - 1.2);
    el.style.setProperty('--field-run', ((camTo - camFrom) * FIELD_RUN).toFixed(1));

    space.innerHTML = rocks.map((r) => {
      const video = r.item.type === 'video';
      const name = `${GALLERY_GROUPS[r.item.group]}${video ? ' video' : ''}: ${galleryLabel(r.item)}`;
      // the drift is handed over as --drift and only switched on (field.css)
      // while the photo is in view
      return `<button class="field-rock is-off" type="button" style="z-index:${n - r.i}" aria-label="${escapeHtml(name)}">
        <span class="field-drift" style="--drift:${r.drift}"><img src="${fieldTiny(r.item)}" alt="" decoding="async" draggable="false">${video ? '<span class="field-play" aria-hidden="true">&#9654;</span>' : ''}</span>
      </button>`;
    }).join('');
    // for screen readers: every photo, in order, with its post
    list.innerHTML = shown.map((item) => `<li>${escapeHtml(`${GALLERY_GROUPS[item.group]}, ${fieldDate(item.date)}: ${galleryLabel(item)}.`)}${item.post
      ? ` <a href="https://www.instagram.com/p/${encodeURIComponent(item.post)}/" target="_blank" rel="noopener" tabindex="-1">View on Instagram</a>` : ''}</li>`).join('');

    [...space.children].forEach((button, k) => {
      const r = rocks[k];
      r.el = button;
      r.img = button.querySelector('img');
      button.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch') return;
        r.pointed = true;
        if (!r.held && r.inFrame && !scrolling()) setHover(r, 1);
      });
      // the one the pointer was resting on when the scrolling stopped
      button.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch' || !r.pointed || r.held || r.hoverTo || !r.inFrame || scrolling()) return;
        setHover(r, 1);
      });
      button.addEventListener('pointerleave', () => {
        r.pointed = false;
        if (!r.focused) setHover(r, 0);
      });
      // tabbed to: forward, like pointing at it (not when focus comes back
      // from a click, which would pull it forward again as it lands)
      button.addEventListener('focus', () => {
        r.focused = button.matches(':focus-visible');
        if (r.focused && !r.held) setHover(r, 1);
      });
      button.addEventListener('blur', () => {
        r.focused = false;
        if (!r.pointed) setHover(r, 0);
      });
      button.addEventListener('click', (e) => {
        const key = e.detail === 0; // Enter or Space
        if (!key && tap && tap.type !== 'mouse' && tap.moved) return;
        hold(r, key ? 'key' : tap ? tap.type : 'mouse');
      });
    });
    if (W) size();
  }

  // Photos are sized against the screen: about a sixth of its width on a
  // computer, a third on a phone, at full size.
  function size() {
    const base = W < 720 ? W * 0.34 : fieldClamp(W * 0.16, 150, 270);
    for (const r of rocks) {
      r.w = base * (r.item.type === 'video' ? 0.8 : 1);
      r.h = r.w * (r.item.h / r.item.w);
      r.el.style.width = `${r.w.toFixed(1)}px`;
      r.el.style.height = `${r.h.toFixed(1)}px`;
      // Keep the middle clear, so none flies straight at you. On a short,
      // wide screen a tall photo close above or below the flight path would
      // cover the middle as it passes: move it out just far enough. Its
      // offset and its size grow together as it nears, so this holds at
      // every depth.
      const across = Math.abs(r.ax) * (W / 2) < r.w / 2 + 16;
      const need = H ? (r.h / 2 + 16) / (H / 2) : 0;
      r.py = across && Math.abs(r.ay) < need ? (r.ay < 0 ? -need : need) : r.ay;
    }
  }

  // Pointed at (1) or not (0): eased there in frame(), or at once (now).
  function setHover(r, to, now) {
    if (now) {
      r.hover = r.hoverFrom = r.hoverTo = to;
      r.el.classList.toggle('is-up', !!to);
      return;
    }
    if (r.hoverTo === to) return;
    r.hoverFrom = r.hover;
    r.hoverTo = to;
    r.hoverAt = performance.now();
    if (to) r.el.classList.add('is-up');
    queue();
  }

  /* ---- each frame ---- */

  // A rock's look, in terms of a picture laid out at the front (f): how
  // far off-centre, how big, turned how far, how bright.
  const pose = (r, f) => ({ dx: r.x - f.x, dy: r.y - f.y, k: (r.w * r.s) / f.w, rot: r.rot, o: r.light });
  // where a photo whose place is off screen falls back to: away into the
  // middle distance, fading
  const sink = (f) => ({ dx: W / 2 - f.x, dy: H / 2 - f.y, k: 0.06, rot: 0, o: 0 });
  const place = (el, p) => {
    el.style.transform = `translate3d(${p.dx.toFixed(1)}px, ${p.dy.toFixed(1)}px, 0) rotate(${p.rot.toFixed(2)}deg) scale(${p.k.toFixed(4)})`;
    el.style.opacity = p.o.toFixed(3);
  };
  // A photo on its way to the front or back carries its rock's drift, eased
  // out on the way up and back in on the way down, so it lands exactly as
  // the rock looks (the drift moves by % of the photo's own size, so it
  // matches at any scale).
  const driftShot = (shot) => {
    const d = shot.dCur;
    shot.media.style.transform = `translate(${d.x.toFixed(2)}%, ${d.y.toFixed(2)}%) rotate(${d.r.toFixed(2)}deg)`;
  };

  function frame(now) {
    queued = false;
    if (!near && !shots.length) return;
    let busy = false;
    // below 0 the stage is still coming up the screen, 0 to 1 it's pinned
    // under the header, past 1 it's leaving off the top; the camera flies
    // the whole time any of it is in view
    const p = (y + navH - top) / run;
    const cam = camFrom + (camTo - camFrom) * fieldClamp(p, -H / run, 1 + H / run);
    let count = 0;

    for (const r of rocks) {
      if (r.hover !== r.hoverTo) {
        const t = fieldClamp((now - r.hoverAt) / FIELD_HOVER_MS);
        r.hover = r.hoverFrom + (r.hoverTo - r.hoverFrom) * fieldEase(t);
        if (t < 1) busy = true;
        else {
          r.hover = r.hoverTo;
          if (!r.hoverTo) r.el.classList.remove('is-up');
        }
      }
      const d = r.z - cam;
      // (never drawn bigger than at FIELD_NEAR: past that, only one still
      // easing back from being pointed at is drawn, and it's fading out)
      let s = 1 / (1 + Math.max(d, FIELD_NEAR));
      let x = W / 2 + r.ax * (W / 2) * s;
      let yy = H / 2 + r.py * (H / 2) * s;
      // the most room it can take up: turned as far as its tilt and drift
      // go, and drifted a little off its spot, so it is only hidden once
      // no corner of it can still be in frame
      const hw = (r.w * s) / 2;
      const hh = (r.h * s) / 2;
      const ex = (hw * r.cos + hh * r.sin) * 1.1;
      const ey = (hh * r.cos + hw * r.sin) * 1.1;
      const inFrame = d > FIELD_NEAR && d < FIELD_FAR
        && x + ex > 0 && x - ex < W && yy + ey > 0 && yy - ey < H;
      // one pulled forward is never cut off: it eases back first, and is
      // only hidden once it's back in its place, out of frame
      r.inFrame = inFrame;
      if (!inFrame && r.hoverTo) setHover(r, 0);
      const show = near && count < FIELD_MAX && (inFrame || r.hover > 0);
      if (show === r.off) {
        r.off = !show;
        r.el.classList.toggle('is-off', r.off);
        if (r.off) {
          setHover(r, 0, true);
          // back to the soft copy, so a long field doesn't keep every
          // full-size photo in memory
          if (r.sharp) {
            r.sharp = false;
            r.img.dataset.want = '';
            r.img.src = fieldTiny(r.item);
          }
        } else {
          // its drift starts again now (field.css only runs it in view)
          r.driftAt = now;
        }
      }
      if (!show) continue;
      count++;

      // brighter as it nears, fading in out of the dark and out again as
      // it passes
      const lit = fieldClamp(1 - d / FIELD_FAR);
      const fade = fieldClamp((FIELD_FAR - d) / 0.8) * fieldClamp((d - FIELD_NEAR) / (-0.05 - FIELD_NEAR));
      let o = (0.22 + 0.78 * lit * lit) * fade;
      let rot = r.turn;
      const h = r.hover;
      if (h > 0) {
        // pointed at: forward to at least near full size, square on and
        // lit (but still fading as it passes the camera)
        s += (Math.max(s * 1.35, 0.95) - s) * h;
        o += (fade - o) * h;
        rot *= 1 - h;
        // tabbed to: also kept inside the frame. Not for a pointer, as
        // moving it could slide it out from under the pointer, which lets
        // it go, which slides it back, over and over.
        if (r.focused && !r.pointed) {
          const bx = (r.w * s) / 2 + 12;
          const by = (r.h * s) / 2 + 12;
          x += (fieldClamp(x, bx, Math.max(bx, W - bx)) - x) * h;
          yy += (fieldClamp(yy, by, Math.max(by, H - by)) - yy) * h;
        }
      }
      r.x = x;
      r.y = yy;
      r.s = s;
      r.rot = rot;
      r.light = o;
      r.el.style.transform = `translate3d(${(x - r.w / 2).toFixed(1)}px, ${(yy - r.h / 2).toFixed(1)}px, 0) rotate(${rot.toFixed(2)}deg) scale(${s.toFixed(4)})`;
      // one that's at the front (or flying there, or back) is drawn by its
      // shot instead; it stays here, unseen, to keep its place and focus
      r.el.style.opacity = r.held ? '0' : o.toFixed(3);
      // the real photo: once close, or once well on its way forward when
      // pointed at (not for a far one merely brushed past)
      if (!r.sharp && (d < FIELD_SHARP || h > 0.6)) {
        r.sharp = true;
        fieldSwap(r.img, galleryThumb(r.item));
      }
    }

    for (let k = shots.length - 1; k >= 0; k--) {
      const shot = shots[k];
      // falling back, its place went out of frame (or came back into it)
      // on the way: set off again from where it is toward the new target,
      // rather than jumping
      if (shot.falling && shot.rock.off !== shot.wasOff) {
        shot.ms = Math.max(450, shot.ms - Math.max(0, now - shot.at));
        shot.at = now;
        shot.from = shot.cur;
        shot.dFrom = shot.dCur;
        shot.wasOff = shot.rock.off;
      }
      const t = fieldClamp((now - shot.at) / shot.ms);
      const e = shot.falling ? fieldEase(t) : fieldOut(t);
      const a = shot.from;
      // falling: toward wherever its rock has got to by now, drift and all
      const back = shot.falling && !shot.rock.off;
      const b = !shot.falling ? { dx: 0, dy: 0, k: 1, rot: 0, o: 1 }
        : back ? pose(shot.rock, shot.f) : sink(shot.f);
      shot.cur = {
        dx: a.dx + (b.dx - a.dx) * e,
        dy: a.dy + (b.dy - a.dy) * e,
        k: a.k + (b.k - a.k) * e,
        rot: a.rot + (b.rot - a.rot) * e,
        o: a.o + (b.o - a.o) * e,
      };
      const da = shot.dFrom;
      const db = back ? fieldDriftAt(shot.rock, now) : FIELD_STILL;
      shot.dCur = { x: da.x + (db.x - da.x) * e, y: da.y + (db.y - da.y) * e, r: da.r + (db.r - da.r) * e };
      if (t < 1) {
        place(shot.el, shot.cur);
        driftShot(shot);
        busy = true;
        continue;
      }
      shots.splice(k, 1);
      if (shot.falling) landed(shot);
      else arrived(shot);
      busy = true;
    }

    const pinned = fieldClamp(p);
    if (Math.abs(pinned - lastP) > 0.0005) {
      lastP = pinned;
      meter.style.transform = `scaleY(${pinned.toFixed(4)})`;
    }
    const gone = p > 0.02 || !!held;
    if (gone !== hintGone) {
      hintGone = gone;
      hint.classList.toggle('is-gone', gone);
    }
    if (busy) queue();
  }

  function queue() {
    if (!queued) {
      queued = true;
      requestAnimationFrame(frame);
    }
  }

  /* ---- holding one at the front ---- */

  // Where a held photo sits: in the middle, as big as fits with room for
  // the chips above and the let-go button below, and on a computer for
  // the notes either side.
  function front(item) {
    const aspect = item.h / item.w;
    // a short stage (a phone on its side) keeps every pixel for the photo:
    // the chips step aside and the button sits beside it (is-bare)
    const short = H < 480;
    const above = short ? 12 : chips ? 72 : 28;
    const below = short ? 12 : 80;
    const room = H - above - below;
    let w;
    let h;
    if (narrow.matches) {
      w = Math.min(W - 40, 560);
      h = w * aspect;
    } else {
      h = Math.min(room, H * 0.72);
      w = Math.min(h / aspect, W * 0.3);
      h = w * aspect;
    }
    if (h > room) {
      h = room;
      w = h / aspect;
    }
    return { x: W / 2, y: above + room / 2, w, h };
  }

  function hold(r, how) {
    if (held && held.rock === r) { letGo(); return; }
    if (held) letGo(false);
    const item = r.item;
    const f = front(item);
    let from = r.off ? sink(f) : pose(r, f);
    let dFrom = r.off ? FIELD_STILL : fieldDriftAt(r, performance.now());
    // picked again while still falling back: carry on from there
    const again = shots.findIndex((s) => s.rock === r);
    if (again >= 0) {
      from = shots[again].cur;
      dFrom = shots[again].dCur;
      shots[again].el.remove();
      shots.splice(again, 1);
    }
    const index = r.i + 1;
    const total = rocks.length;
    const group = escapeHtml(GALLERY_GROUPS[item.group]);
    const alt = escapeHtml(`${GALLERY_GROUPS[item.group]}${item.type === 'video' ? ' video' : ' photo'}: ${galleryLabel(item)}`);
    const post = item.post ? `https://www.instagram.com/p/${encodeURIComponent(item.post)}/` : '';
    // Too small for notes (a short screen): just the photo, with the
    // Instagram link and the let-go button either side of it. The caption
    // is still read out (live, below).
    const bare = f.h < 260 || f.w < 220;
    // notes round the photo: pinned at x% across, y% down, to the left or
    // right (a wide photo has less height, so the caption goes lower to
    // keep clear of the note above it)
    const wide = item.h < item.w;
    const notes = bare ? [] : [
      ['r', 72, 9, `<span class="note">${fieldDate(item.date)}<small>Posted</small></span>`],
      ['l', 26, wide ? 22 : 27, `<span class="note">${group}<small>${index} / ${total}</small></span>`],
      item.caption && ['r', 64, wide ? 62 : 55, `<span class="note is-caption"><span class="cap">${escapeHtml(item.caption)}</span><small>From the post</small></span>`],
      post && ['l', 34, 83, `<a class="note" href="${post}" target="_blank" rel="noopener"><u>View on Instagram &nearr;</u><small>@ynr_multiverse</small></a>`],
    ].filter(Boolean);
    const say = how === 'touch' ? 'Tap again to let go' : how === 'key' ? 'Enter or Esc to let go' : 'Click again to let go';

    const shot = document.createElement('figure');
    shot.className = `field-held is-moving${bare ? ' is-bare' : ''}`;
    shot.style.cssText = `left:${(f.x - f.w / 2).toFixed(1)}px; top:${(f.y - f.h / 2).toFixed(1)}px; width:${f.w.toFixed(1)}px; height:${f.h.toFixed(1)}px`;
    shot.innerHTML = `<div class="field-held-media"><img src="${r.img.currentSrc || r.img.src}" alt="${alt}" draggable="false"></div>
      ${bare ? (post ? `<a class="field-ig" href="${post}" target="_blank" rel="noopener">Instagram &nearr;</a>` : '')
    : `<ul>${notes.map(([side, nx, ny, note], i) => `<li class="callout ${side}" style="--x:${nx}%; --y:${ny}%; --i:${i}"><span class="pin" aria-hidden="true"></span><span class="line" aria-hidden="true"></span>${note}</li>`).join('')}</ul>`}
      <button class="field-letgo" type="button">${say}</button>`;
    const media = shot.querySelector('.field-held-media');
    place(shot, from);
    stage.insertBefore(shot, scrim.nextSibling);
    fieldSwap(shot.querySelector('img'), fieldBig(item));

    r.held = true;
    r.el.classList.add('is-held');
    // its rock stays behind, unseen, holding its place: out of the Tab
    // order until the photo is back in it
    r.el.tabIndex = -1;
    setHover(r, 0, true);
    held = { rock: r, el: shot, media, f, from, cur: from, dFrom, dCur: dFrom, wasOff: r.off, at: performance.now(), ms: FIELD_RISE_MS, falling: false };
    driftShot(held);
    shots.push(held);
    stage.classList.add('is-holding');
    live.textContent = `Holding ${index} of ${total}: ${GALLERY_GROUPS[item.group]}, posted ${fieldDate(item.date)}. ${galleryLabel(item)}`;
    shot.querySelector('.field-letgo').focus({ preventScroll: true });
    queue();
  }

  // At the front: square on, notes drawn in, and a Reel starts playing.
  function arrived(shot) {
    shot.el.style.transform = '';
    shot.el.style.opacity = '';
    shot.media.style.transform = '';
    shot.el.classList.remove('is-moving');
    shot.el.classList.add('is-labelled');
    const item = shot.rock.item;
    if (item.type !== 'video') return;
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    video.poster = fieldBig(item);
    video.src = `${GALLERY_DIR}${item.id}.mp4`;
    video.setAttribute('aria-hidden', 'true');
    shot.el.querySelector('.field-held-media').append(video);
    video.play().catch(() => {});
  }

  function letGo(refocus = true) {
    const shot = held;
    if (!shot) return;
    held = null;
    const hadFocus = shot.el.contains(document.activeElement);
    shot.falling = true;
    shot.from = shot.cur;
    shot.dFrom = shot.dCur;
    shot.wasOff = shot.rock.off;
    shot.at = performance.now();
    shot.ms = FIELD_FALL_MS;
    shot.el.classList.remove('is-labelled');
    shot.el.classList.add('is-moving', 'is-falling');
    fieldStopVideo(shot.el);
    if (!shots.includes(shot)) shots.push(shot);
    stage.classList.remove('is-holding');
    live.textContent = 'Let go.';
    // back to the photo, if it's still in view to take it
    if (hadFocus && refocus) (shot.rock.off ? space : shot.rock.el).focus({ preventScroll: true });
    queue();
  }

  function landed(shot) {
    shot.el.remove();
    const r = shot.rock;
    if (held && held.rock === r) return;
    r.held = false;
    r.el.classList.remove('is-held');
    r.el.removeAttribute('tabindex');
    // shown in this same frame (frame() has already been past it), so
    // there's no blink between the photo landing and its rock taking over
    if (!r.off) r.el.style.opacity = r.light.toFixed(3);
    if (document.activeElement === r.el && r.el.matches(':focus-visible')) {
      r.focused = true;
      setHover(r, 1);
    }
  }

  // Everything back in its place at once (the field leaving the screen, a
  // new group picked, the window resized).
  function drop() {
    const all = held && !shots.includes(held) ? [...shots, held] : [...shots];
    if (!all.length) return;
    const hadFocus = all.some((shot) => shot.el.contains(document.activeElement));
    for (const shot of all) {
      fieldStopVideo(shot.el);
      shot.el.remove();
      shot.rock.held = false;
      shot.rock.el.classList.remove('is-held');
      shot.rock.el.removeAttribute('tabindex');
    }
    shots.length = 0;
    held = null;
    stage.classList.remove('is-holding');
    live.textContent = '';
    // the field itself, which is never hidden (the stage may be, if it
    // has just scrolled away)
    if (hadFocus) el.focus({ preventScroll: true });
    queue();
  }

  /* ---- input ---- */

  // A press that turns into a scroll or a drag isn't a tap.
  stage.addEventListener('pointerdown', (e) => {
    tap = { x: e.clientX, y: e.clientY, type: e.pointerType, moved: false };
  }, { passive: true });
  stage.addEventListener('pointermove', (e) => {
    if (!tap || tap.type === 'mouse' || tap.moved) return;
    if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap.moved = true;
  }, { passive: true });
  stage.addEventListener('pointercancel', () => { if (tap) tap.moved = true; });

  // Clicking the held photo, its button or the space round it lets go
  // (the photos and chips look after their own clicks, links just go).
  stage.addEventListener('click', (e) => {
    if (!held || e.target.closest('.field-rock, .field-chips, a')) return;
    if (e.detail !== 0 && tap && tap.type !== 'mouse' && tap.moved) return;
    letGo();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && held) letGo();
  });

  if (chips) {
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-group]');
      if (!chip || chip.dataset.group === field.group) return;
      fieldPick(field, chips, chip.dataset.group);
      drop();
      populate();
      measure();
      // a different group is a different flight: start it from the top
      if (y + navH > top + 2) window.scrollTo({ top: top - navH, behavior: 'instant' });
    });
  }

  /* ---- where things are ---- */

  // The field's place on the page and the stage's size. Read once, and
  // again whenever the page changes height, never while scrolling.
  function measure() {
    const nav = header ? header.offsetHeight : 0;
    if (nav !== navH) {
      navH = nav;
      el.style.setProperty('--field-nav', `${navH}px`);
    }
    y = window.scrollY;
    const box = el.getBoundingClientRect();
    top = box.top + y;
    H = stage.clientHeight;
    stage.classList.toggle('is-short', H < 480);
    run = Math.max(1, box.height - H);
    const w = stage.clientWidth;
    if (w !== W || H !== sizedH) {
      W = w;
      sizedH = H;
      size();
      drop();
    }
    queue();
  }

  populate();
  window.addEventListener('scroll', () => {
    y = window.scrollY;
    lastScroll = performance.now();
    if (near) queue();
  }, { passive: true });
  window.addEventListener('resize', measure);
  if ('ResizeObserver' in window) {
    let pending = false;
    new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; measure(); }, 0);
    }).observe(document.body);
  }
  new IntersectionObserver((entries) => {
    const was = near;
    near = entries[entries.length - 1].isIntersecting;
    // put any held photo back before the stage is hidden
    if (!near) drop();
    // back on screen, the drifts of the photos still in view start again
    else if (!was) {
      const now = performance.now();
      for (const r of rocks) if (!r.off) r.driftAt = now;
    }
    stage.classList.toggle('is-away', !near);
    queue();
  }, { rootMargin: '10% 0px' }).observe(el);
  measure();
}
