/* ==========================================================================
   Smooth scroll
   Mouse wheels and trackpads scroll every page in a glide instead of in
   steps: each turn of the wheel moves a target, and the page eases toward
   it. Touch screens already scroll smoothly by themselves. The keyboard,
   the scrollbar, links and find-in-page keep the browser's own scrolling,
   and the glide picks up from wherever they leave the page. A wheel over
   something that scrolls on its own (the bag, a pop-up) scrolls that.
   Off with reduced motion.
   ========================================================================== */

const SMOOTH_GLIDE = 0.12;   // seconds to cover ~2/3 of the way to the target
const SMOOTH_LINE = 40;      // px per line, for wheels that count in lines

function initSmoothScroll() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  let target = window.scrollY;
  let current = window.scrollY;
  let placed = -1;     // where the glide last put the page
  let last = 0;
  let running = false;

  // Is there something under the pointer, between it and the page, that
  // would scroll by itself in this direction?
  function scrollsItself(el, dy) {
    for (; el && el !== document.body && el !== root; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight || !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
    }
    return false;
  }

  function stop() {
    running = false;
    placed = -1;
    root.style.scrollBehavior = ''; // back to the stylesheet's (smooth jumps to #anchors)
  }

  function tick(now) {
    // Moved by something else meanwhile (the keyboard, the scrollbar):
    // give way to it.
    if (placed !== -1 && Math.abs(window.scrollY - placed) > 2) {
      target = current = window.scrollY;
      stop();
      return;
    }
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    current += (target - current) * (1 - Math.exp(-dt / SMOOTH_GLIDE));
    if (Math.abs(target - current) < 0.5) current = target;
    window.scrollTo(0, current);
    placed = window.scrollY;
    if (current !== target) requestAnimationFrame(tick);
    else stop();
  }

  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || scrollsItself(e.target, e.deltaY)) return;
    e.preventDefault();
    if (!running) target = current = window.scrollY;
    const unit = e.deltaMode === 1 ? SMOOTH_LINE : e.deltaMode === 2 ? window.innerHeight : 1;
    const end = root.scrollHeight - window.innerHeight;
    target = Math.max(0, Math.min(end, target + e.deltaY * unit));
    if (!running) {
      running = true;
      // The stylesheet's smooth scrolling would make every step of the
      // glide a smooth scroll of its own.
      root.style.scrollBehavior = 'auto';
      last = performance.now();
      requestAnimationFrame(tick);
    }
  }, { passive: false });
}
