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
   - the world tiles fetch their real photo the first time they're pointed
     at or focused, so a phone, which can't point, never downloads them.
   Only the `translate` property is set, from a scroll position read in the
   scroll event (as galaxy.js does), and only for sections near the screen:
   the graphics chip moves them without the page being laid out again.
   ========================================================================== */

const DEPTH_TRAVEL = 110; // px a layer of depth 1 moves over its section's pass

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
  if (!stages.length) return;

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
  };
  const queue = () => {
    if (!queued) { queued = true; requestAnimationFrame(place); }
  };

  // Where each section sits on the page. Read once, and again whenever the
  // page changes height (the film going live, pictures arriving), never
  // while scrolling.
  const measure = () => {
    vh = window.innerHeight;
    y = window.scrollY;
    for (const stage of stages) {
      const box = stage.el.getBoundingClientRect();
      stage.top = box.top + y;
      stage.height = box.height;
    }
    queue();
  };

  const near = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const stage = stages.find((s) => s.el === e.target);
      if (stage) stage.near = e.isIntersecting;
    }
    queue();
  }, { rootMargin: '25% 0px' });
  stages.forEach((stage) => near.observe(stage.el));

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
