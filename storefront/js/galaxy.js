/* ==========================================================================
   Galaxy
   The living night sky behind every page, picking up where the home page
   film ends, in space: three layers of stars that drift slowly and slide
   at different speeds as the page scrolls (so the sky has depth), stars
   that twinkle, slow clouds of dust with a red bruise in them, and now and
   then a shooting star. In light mode it's the negative: ink on paper.

   Cheap by design. The stars are painted once, into tiles, when the page
   loads; everything that moves after that is those finished layers being
   slid and faded, which the graphics chip does almost for free. (Working
   the sky out pixel by pixel every frame in WebGL looked the same but cost
   enough to make an ordinary laptop drop frames from the home page film.)
   With reduced motion the sky is there but holds still.
   ========================================================================== */

const GALAXY_TILE = 1024;     // px: each star layer repeats every this many px
// Far to near: how many stars a tile holds, their radius and brightness
// ranges, and how far the layer slides per px of scroll.
const GALAXY_LAYERS = [
  { count: 900, size: [0.35, 0.8], alpha: [0.25, 0.55], depth: 0.05 },
  { count: 240, size: [0.6, 1.2], alpha: [0.4, 0.8], depth: 0.14, twinkle: true },
  { count: 60, size: [1, 1.9], alpha: [0.6, 1], depth: 0.3 },
];

// One tile of stars, painted on a canvas: each a bright dot in a faint
// glow, at a seeded-random spot, so the sky is the same on every page.
function galaxyTile(seed, { count, size, alpha }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GALAXY_TILE;
  const ctx = canvas.getContext('2d');
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  ctx.fillStyle = '#f2efe9';
  for (let i = 0; i < count; i++) {
    const x = rnd() * GALAXY_TILE;
    const y = rnd() * GALAXY_TILE;
    const r = size[0] + rnd() * (size[1] - size[0]);
    const a = alpha[0] + rnd() * (alpha[1] - alpha[0]);
    // Drawn again across any edge it touches, so the tile repeats seamlessly.
    for (const dx of [-GALAXY_TILE, 0, GALAXY_TILE]) {
      for (const dy of [-GALAXY_TILE, 0, GALAXY_TILE]) {
        const px = x + dx;
        const py = y + dy;
        if (px < -8 || px > GALAXY_TILE + 8 || py < -8 || py > GALAXY_TILE + 8) continue;
        ctx.globalAlpha = a * 0.22;
        ctx.beginPath(); ctx.arc(px, py, r * 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  return new Promise((done) => canvas.toBlob((blob) => done(URL.createObjectURL(blob)), 'image/png'));
}

function initGalaxy() {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sky = document.createElement('div');
  sky.className = 'galaxy';
  sky.setAttribute('aria-hidden', 'true');
  sky.innerHTML = `<div class="galaxy-dust"></div>${GALAXY_LAYERS.map((l) =>
    `<div class="galaxy-layer"><div class="galaxy-stars"></div>${l.twinkle ? '<div class="galaxy-stars twinkle"></div>' : ''}</div>`).join('')}
    <i class="galaxy-shooting"></i>`;
  document.body.prepend(sky);
  document.documentElement.classList.add('has-galaxy');
  const layers = [...sky.querySelectorAll('.galaxy-layer')];

  // Paint the tiles when the page has a moment, then fade the sky in.
  const paint = async () => {
    for (const [i, layer] of GALAXY_LAYERS.entries()) {
      const fields = layers[i].querySelectorAll('.galaxy-stars');
      for (const [j, field] of [...fields].entries()) {
        field.style.backgroundImage = `url(${await galaxyTile(101 + i * 17 + j * 5, j ? { ...layer, count: layer.count * 0.5 } : layer)})`;
      }
    }
    sky.classList.add('is-lit');
  };
  if (window.requestIdleCallback) window.requestIdleCallback(paint, { timeout: 600 });
  else setTimeout(paint, 60);

  if (still) return;

  // Depth: each layer slides by a share of the scroll, wrapping every tile
  // so it never runs out. Transforms only, so the graphics chip moves them.
  // The scroll position is read in the scroll event, before other scripts
  // change any styles: read later in the frame, it made the browser redo
  // the page's style there and then, 30-60ms during a fast scroll.
  let y = window.scrollY;
  let queued = false;
  const place = () => {
    queued = false;
    layers.forEach((el, i) => {
      el.style.transform = `translate3d(0, ${-((y * GALAXY_LAYERS[i].depth) % GALAXY_TILE)}px, 0)`;
    });
  };
  window.addEventListener('scroll', () => {
    y = window.scrollY;
    if (!queued) { queued = true; requestAnimationFrame(place); }
  }, { passive: true });
  place();

  // A shooting star every so often, each from somewhere new.
  const shooter = sky.querySelector('.galaxy-shooting');
  const aim = () => {
    shooter.style.top = `${5 + Math.random() * 40}%`;
    shooter.style.left = `${35 + Math.random() * 60}%`;
  };
  aim();
  shooter.addEventListener('animationiteration', aim);
}
