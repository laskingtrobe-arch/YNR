/* ==========================================================================
   Glitch
   The alien-invasion layer over every page:
   - bursts of glitch, every couple of seconds and more often while the
     page scrolls: short dashes of red, cyan, green and white bleeding in
     from the left and right edges of the screen (never across it),
     hairline tears that invert what's under them, the film tearing in the
     same kind of edge dashes with its colours split (film.js reads
     glitchState), and a heading or two flickering through alien glyphs;
   - the transmission strips (layout.js) and the header ticker drift side
     to side, speed up as the page scrolls, and run backwards while it
     scrolls back up;
   - display headings decode out of alien glyphs as they first come into
     view (the film's captions as the film brings them in).

   Flicker is kept under the rate that can trigger seizures in people with
   photosensitive epilepsy (no more than three flashes a second): a burst's
   dashes hold still for its length, and bursts come at most every
   GLITCH_GAP ms.

   Kept cheap, because it runs over the scroll and the film: nothing in the
   middle of the page is moved or restyled (knocking text and images
   sideways, or flickering headings' shadows for the length of a fast
   scroll, meant redrawing them, and stalled or dropped frames).

   The real text stays in the page throughout, for screen readers and
   search engines: the glyphs play on an aria-hidden copy laid over it.
   With reduced motion turned on none of this runs: the strips stand still
   (store.css) and the headings stay as they are.
   ========================================================================== */

// Roughly letter-width in the display font's fallbacks: block characters
// (▓ █) come out far wider and would sprawl past the real heading.
const GLITCH_GLYPHS = 'ΣΞΨΩΔΛΠΦΓΘ∑∏∞≈≠≡±×µ¤§◊▲►▼◄0123456789#%&@?/';
// For headings in the wide face (Archivo), which has Latin letters only:
// a glyph it lacks comes from a fallback font with taller lines, and the
// moving copy then slips a line below the real heading.
const GLITCH_LATIN = '¤§±×µ¢£¥©®°¶ØÞßÆ0123456789#%&@?/';
const GLITCH_ON = 900;        // px a second of scrolling from which bursts come as fast as GLITCH_GAP allows, and the grain thickens
const GLITCH_HARD = 2200;     // ...and from which they're at full strength, and the grain thicker still
const GLITCH_SPEEDUP = 250;   // px a second of scrolling that adds one more "normal speed" to the strips
// The strips' speeds, as multiples of normal (negative runs them
// backwards). They change gear rather than following the scroll smoothly:
// every change of speed makes the browser rebuild the animation on the
// main thread, and doing that every frame cost ~4ms a frame, with stalls
// of up to 200ms, on an ordinary laptop.
const GLITCH_GEARS = [-14, -10, -7, -4, -2, 1, 2, 4, 7, 10, 14];
const GLITCH_SHIFT = 150;     // ms between gear changes, at the least
const GLITCH_GAP = 400;       // ms from the start of one burst to the next, at the least
const GLITCH_IDLE = [1400, 3200]; // ms between bursts while the page is still
// The dashes a burst can use: up to this many show at once, each hugging
// the left or right edge.
const GLITCH_DASHES = ['red', 'cyan', 'tear', 'green', 'red', 'white', 'cyan', 'tear', 'red', 'cyan'];

// Read by the film (film.js) whenever it draws: how hard it should tear
// right now (0 = not at all) and a number that changes with every new tear
// pattern. It redraws on each change (onGlitch).
const glitchState = { level: 0, seed: 0 };
const glitchListeners = new Set();
function onGlitch(fn) { glitchListeners.add(fn); }
function glitchChanged() { for (const fn of glitchListeners) fn(); }

function glitchGlyph(set = GLITCH_GLYPHS) {
  return set[Math.floor(Math.random() * set.length)];
}

// Plays a heading's letters through alien glyphs for `duration` ms. With
// `decode` the glyphs settle into the real text left to right; without it
// a scattering of letters (`share` of them) flickers and then snaps back.
// The heading's own text turns transparent meanwhile and an aria-hidden
// copy on top does the moving, so nothing changes for a screen reader.
function glitchText(el, { duration = 700, decode = true, share = 0.35 } = {}) {
  if (el.classList.contains('is-glitching') || !el.textContent.trim()) return;
  const glyphs = el.closest('.wide') ? GLITCH_LATIN : GLITCH_GLYPHS;
  const copy = document.createElement('span');
  copy.className = 'glitch-copy';
  copy.setAttribute('aria-hidden', 'true');
  copy.innerHTML = el.innerHTML;
  const texts = [];
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push({ node: n, real: n.data });
  const total = texts.reduce((sum, t) => sum + t.real.length, 0) || 1;
  el.classList.add('is-glitching');
  el.appendChild(copy);

  const start = performance.now();
  let swapped = 0;
  const step = (now) => {
    // Something replaced the heading's text meanwhile (a product name
    // arriving, say): the copy went with it, so just stand down.
    if (!copy.isConnected) { el.classList.remove('is-glitching'); return; }
    const t = Math.min((now - start) / duration, 1);
    if (t === 1) { copy.remove(); el.classList.remove('is-glitching'); return; }
    if (now - swapped > 50) { // fresh glyphs ~20 times a second, not every frame
      swapped = now;
      let seen = 0;
      for (const { node, real } of texts) {
        let out = '';
        for (const ch of real) {
          const keep = ch.trim() === '' || (decode ? seen / total < t : Math.random() > share);
          out += keep ? ch : glitchGlyph(glyphs);
          seen++;
        }
        node.data = out;
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function initGlitch() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const html = document.documentElement;

  /* ---- headings ---- */

  const headings = [...document.querySelectorAll('.display')];
  const decodeIn = (el) => glitchText(el, { duration: 500 + el.textContent.length * 14 });

  // Decode each heading the first time it's mostly in view. The film's
  // captions sit in view all along, invisible until their stretch of the
  // scroll, so those decode when film.js brings them in instead.
  const firstSight = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      firstSight.unobserve(e.target);
      decodeIn(e.target);
    }
  }, { threshold: 0.5 });
  for (const el of headings) if (!el.closest('[data-beat]')) firstSight.observe(el);
  document.addEventListener('film:beat', (e) => e.target.querySelectorAll('.display').forEach(decodeIn));

  // Which headings are on screen right now, for the flickers below.
  const onScreen = new Set();
  const watch = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) onScreen.add(e.target);
      else onScreen.delete(e.target);
    }
  });
  for (const el of headings) watch.observe(el);
  const showing = (el) => {
    const beat = el.closest('[data-beat]');
    return !beat || beat.style.visibility !== 'hidden';
  };

  function flickerHeadings(count) {
    const pool = [...onScreen].filter(showing);
    for (let i = 0; i < count && pool.length; i++) {
      const el = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      glitchText(el, { duration: 240, decode: false, share: 0.3 });
    }
  }

  /* ---- bursts: dashes at the edges of the screen ---- */

  const veil = document.createElement('div');
  veil.className = 'glitch-veil';
  veil.setAttribute('aria-hidden', 'true');
  veil.innerHTML = GLITCH_DASHES.map((kind) => `<i class="${kind}"></i>`).join('');
  document.body.appendChild(veil);
  const dashes = [...veil.children];

  let bursting = false;
  let lastBurst = -Infinity;

  function burst(strength) {
    const now = performance.now();
    if (bursting || document.hidden || now - lastBurst < GLITCH_GAP) return;
    bursting = true;
    lastBurst = now;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Lay the dashes out once for the whole burst (see the note on flicker
    // at the top): some of them, each against the left or the right edge,
    // a few percent of the screen's width long.
    for (const dash of dashes) {
      dash.hidden = Math.random() > 0.3 + 0.5 * strength;
      if (dash.hidden) continue;
      const tear = dash.classList.contains('tear');
      const height = tear ? 1 + Math.random() * 2 : 2 + Math.random() * 12 * strength;
      dash.style.width = `${w * (0.03 + Math.random() * 0.17 * strength)}px`;
      dash.style.height = `${height}px`;
      dash.style.top = `${Math.random() * (h - height)}px`;
      const left = Math.random() < 0.5;
      dash.style.left = left ? '0' : 'auto';
      dash.style.right = left ? 'auto' : '0';
    }
    veil.classList.add('on');
    flickerHeadings(strength > 0.7 ? 2 : 1);

    const end = now + 120 + strength * 200;
    let reseeded = 0;
    const step = (t) => {
      if (t >= end) {
        veil.classList.remove('on');
        glitchState.level = 0;
        glitchChanged();
        bursting = false;
        return;
      }
      // A new tear pattern for the film ~12 times a second. (The dashes
      // and hairline tears hold still: moving them every frame cost more
      // than it showed.)
      if (t - reseeded > 80) {
        reseeded = t;
        glitchState.seed = Math.random() * 100;
        glitchState.level = strength * (0.6 + 0.4 * Math.random());
        glitchChanged();
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const idle = () => setTimeout(() => {
    burst(0.45 + Math.random() * 0.4);
    idle();
  }, GLITCH_IDLE[0] + Math.random() * (GLITCH_IDLE[1] - GLITCH_IDLE[0]));
  idle();

  /* ---- scrolling: strips, ticker, glitch level ---- */

  const loops = [...document.querySelectorAll('.tx-track, .ticker-track')]
    .flatMap((el) => (el.getAnimations ? el.getAnimations() : []));
  // Start each loop an hour in: scrolling back up plays them in reverse,
  // and one run back to its very start would stop there.
  for (const a of loops) a.currentTime = 3600e3;

  let speed = 0;       // px a second, + down, - up; eases back to 0 once the scroll stops
  let lastY = window.scrollY;
  let lastT = performance.now();
  let rate = 1;        // the strips' current gear
  let shifted = 0;     // when it last changed
  let level = 0;       // 0 calm, 1 glitching, 2 glitching hard
  let prev = 0;
  let running = false;

  function setRate(r) {
    rate = r;
    for (const a of loops) {
      if (a.updatePlaybackRate) a.updatePlaybackRate(r);
      else a.playbackRate = r;
    }
  }

  function tick(now) {
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;
    // No scroll event for a moment means the scroll has stopped: ease off.
    if (now - lastT > 60) speed *= Math.exp(-dt / 0.18);
    if (Math.abs(speed) < 20) speed = 0;

    const want = 1 + speed / GLITCH_SPEEDUP;
    const gear = speed === 0 ? 1 : GLITCH_GEARS.reduce((best, g) => (Math.abs(g - want) < Math.abs(best - want) ? g : best), 1);
    if (gear !== rate && now - shifted > GLITCH_SHIFT) {
      setRate(gear);
      shifted = now;
    }

    const fast = Math.abs(speed);
    // A lower bar to stop glitching than to start, so it doesn't flicker
    // on and off at the threshold.
    const next = fast > GLITCH_HARD ? 2 : fast > GLITCH_ON ? 1 : fast < GLITCH_ON * 0.6 ? 0 : Math.min(level, 1);
    if (next !== level) {
      html.classList.toggle('glitch-on', next >= 1);
      html.classList.toggle('glitch-hard', next === 2);
      level = next;
    }
    // Scrolling brings the bursts on: as often as the gap allows once it's
    // fast, harder the faster.
    if (fast > GLITCH_ON) burst(Math.min(1, 0.55 + fast / (GLITCH_HARD * 2)));

    if (speed !== 0 || rate !== 1) requestAnimationFrame(tick);
    else running = false;
  }

  window.addEventListener('scroll', () => {
    const now = performance.now();
    const dt = Math.max(now - lastT, 8) / 1000;
    speed = speed * 0.5 + ((window.scrollY - lastY) / dt) * 0.5;
    lastY = window.scrollY;
    lastT = now;
    if (!running) {
      running = true;
      prev = now;
      requestAnimationFrame(tick);
    }
  }, { passive: true });
}
