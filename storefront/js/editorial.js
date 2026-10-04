/* ==========================================================================
   Editorial
   Motion for the editorial sections (store.css, "Editorial sections"):
   - anything marked data-reveal slides in the first time it's on screen,
     and a section marked data-inview gets .is-in then (the poster sprays
     its graffiti on, the anatomy draws its lines);
   - layers marked data-depth drift against the scroll inside their section
     (data-stage), which gives the page headers, the poster and the
     lookbooks their depth: positive depths lag behind like far-off things,
     negative ones run ahead like near ones;
   - a section marked data-rail (the home page's moments) pins under the
     header while the scroll slides its .rail-track sideways, bringing each
     slide in from the left and letting it settle before the next; the page
     moves on after the last;
   - the world tiles fetch their real photo the first time they're pointed
     at or focused, so a phone, which can't point, never downloads them.
   Only transforms and opacity are set, from a scroll position read in the
   scroll event (as galaxy.js does), and only for sections near the screen:
   the graphics chip moves them without the page being laid out again.
   ========================================================================== */

const DEPTH_TRAVEL = 110; // px a layer of depth 1 moves over its section's pass
const RAIL_SCROLL = 0.85; // screens of scrolling per slide on a rail
const RAIL_REST = 0.36;   // share of each slide's scroll it sits still for

function initEditorial() {
  for (const tile of document.querySelectorAll('.world')) {
    const real = tile.querySelector('.world-real[data-src]');
    if (!real) continue;
    const load = () => {
      if (!real.dataset.src) return;
      real.src = real.dataset.src;
      real.removeAttribute('data-src');
    };
    tile.addEventListener('pointerenter', load);
    tile.addEventListener('focus', load);
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;

  /* ---- first sight ---- */
  document.documentElement.classList.add('has-reveal');
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      seen.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  document.querySelectorAll('[data-reveal], [data-inview]').forEach((el) => seen.observe(el));

  /* ---- depth ---- */
  const stages = [...document.querySelectorAll('[data-stage]')]
    .map((el) => ({
      el,
      layers: [...el.querySelectorAll('[data-depth]')].map((layer) => ({ el: layer, depth: Number(layer.dataset.depth) || 0 })),
      top: 0,
      height: 0,
      near: false,
    }))
    .filter((stage) => stage.layers.length);

  /* ---- rails ---- */
  const rails = [...document.querySelectorAll('[data-rail]')]
    .map((el) => ({
      el,
      track: el.querySelector('.rail-track'),
      slides: [...el.querySelectorAll('.rail-track > *')],
      now: el.querySelector('.rail-now'),
      dots: [...el.querySelectorAll('.rail-dots i')],
      top: 0,
      pin: 0,  // the header's height: where the stage pins
      run: 1,  // px of scrolling from the first slide to the last
      step: 0, // px from one slide to the next
      at: 0,
      near: false,
    }))
    .filter((rail) => rail.track && rail.slides.length > 1);
  rails.forEach((rail) => rail.el.classList.add('is-rail'));

  if (!stages.length && !rails.length) return;

  let y = window.scrollY;
  let vh = window.innerHeight;
  let queued = false;

  const place = () => {
    queued = false;
    for (const stage of stages) {
      if (!stage.near) continue;
      // -1 as the section comes up from below the screen, 1 as it leaves
      // off the top
      const pass = ((y + vh - stage.top) / (vh + stage.height)) * 2 - 1;
      const p = Math.max(-1, Math.min(1, pass));
      for (const layer of stage.layers) {
        layer.el.style.translate = `0 ${(p * layer.depth * DEPTH_TRAVEL).toFixed(1)}px`;
      }
    }
    for (const rail of rails) {
      if (!rail.near) continue;
      const last = rail.slides.length - 1;
      const t = Math.max(0, Math.min(1, (y - (rail.top - rail.pin)) / rail.run)) * last;
      // Each slide's stretch of scroll: still for a moment, then an eased
      // glide to the next, so every moment settles in view.
      const i = Math.min(Math.floor(t), last - 1);
      const k = Math.max(0, Math.min(1, (t - i - RAIL_REST / 2) / (1 - RAIL_REST)));
      const pos = i + k * k * (3 - 2 * k);
      rail.track.style.transform = `translate3d(${(pos * rail.step).toFixed(1)}px, 0, 0)`;
      rail.slides.forEach((slide, n) => {
        slide.style.opacity = (1 - Math.min(Math.abs(n - pos), 1) * 0.6).toFixed(3);
      });
      const at = Math.round(pos);
      if (at !== rail.at) {
        rail.at = at;
        if (rail.now) rail.now.textContent = String(at + 1).padStart(2, '0');
        rail.dots.forEach((dot, n) => dot.classList.toggle('on', n === at));
      }
    }
  };
  const queue = () => {
    if (!queued) { queued = true; requestAnimationFrame(place); }
  };

  // Where each section sits on the page. Read once, and again whenever the
  // page changes height (the film going live, pictures arriving), never
  // while scrolling.
  const header = document.querySelector('header.site-nav');
  const measure = () => {
    vh = window.innerHeight;
    y = window.scrollY;
    for (const stage of stages) {
      const box = stage.el.getBoundingClientRect();
      stage.top = box.top + y;
      stage.height = box.height;
    }
    for (const rail of rails) {
      // The section is as tall as its pinned stage plus the scrolling the
      // slides take; set only when that changes, as it moves the page.
      rail.pin = header ? header.offsetHeight : 0;
      rail.run = Math.round(vh * RAIL_SCROLL * (rail.slides.length - 1));
      const height = `${vh - rail.pin + rail.run}px`;
      if (rail.el.style.height !== height) rail.el.style.height = height;
      rail.top = rail.el.getBoundingClientRect().top + y;
      rail.step = rail.slides[0].offsetLeft - rail.slides[1].offsetLeft;
    }
    queue();
  };

  // A slide's link reached with the Tab key scrolls the page to that slide,
  // so the focus is never on a slide out of view.
  for (const rail of rails) {
    rail.el.addEventListener('focusin', (e) => {
      const n = rail.slides.findIndex((slide) => slide.contains(e.target));
      if (n < 0 || n === rail.at) return;
      const to = rail.top - rail.pin + (rail.run * n) / (rail.slides.length - 1);
      window.scrollTo({ top: to, behavior: 'instant' });
    });
  }

  const near = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const scene = stages.find((s) => s.el === e.target) || rails.find((r) => r.el === e.target);
      if (scene) scene.near = e.isIntersecting;
    }
    queue();
  }, { rootMargin: '25% 0px' });
  stages.forEach((stage) => near.observe(stage.el));
  rails.forEach((rail) => near.observe(rail.el));

  window.addEventListener('scroll', () => {
    y = window.scrollY;
    queue();
  }, { passive: true });
  window.addEventListener('resize', measure);
  if ('ResizeObserver' in window) {
    let pending = false;
    new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; measure(); });
    }).observe(document.body);
  }
  measure();
}
