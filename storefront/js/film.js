/* ==========================================================================
   Film
   The scroll-driven film at the top of the home page. It is a run of still
   frames (cut by server/scripts/film-frames.js) drawn as the page scrolls:
   scrolling down plays it, scrolling up rewinds it. Portrait screens get
   the tall cut, everything else the wide one.

   What keeps it moving smoothly rather than in steps:
   - the playhead glides toward the scroll position instead of jumping to
     it, so a flick of the wheel plays through rather than snapping;
   - between two frames, the next one fades in over the last, so there are
     no hard steps (this also covers gaps while frames are still arriving);
   - the picture pushes in slowly and the text drifts at its own pace over
     it, so even a near-still shot keeps moving under the scroll;
   - the frames live on the graphics chip (WebGL), so each screen update is
     just "blend these two, this much". Getting a frame there is the slow
     part, 7-11ms on an ordinary laptop's Intel graphics, so it only ever
     happens while the page is idle, nearest frames first, and never in the
     middle of drawing a scroll. A black-and-white film is stored one byte a
     pixel, so the whole of it fits (about 90MB); a colour film would keep
     only the frames either side of the playhead that fit the same budget.
   (Drawing frames through a plain 2D canvas instead stalled the page for
   50-120ms at a time, which is what made the first version pause.)

   The page says where the frames live, how many there are, and whether
   they are black and white:
     <section id="film" data-film="/assets/film/ufo-v1" data-wide="96" data-tall="96" data-gray>
   Text inside it with data-beat="from,to" (0 = top of the film, 1 = end)
   fades in and out over that stretch of the scroll.

   With reduced motion or the browser's data saver turned on, without
   JavaScript, or without WebGL, none of this runs: the first frame stays
   as a still behind the opening text, and no other frames are downloaded.
   ========================================================================== */

const FILM_FADE = 0.04;      // how much of the scroll a caption takes to fade
const FILM_GLIDE = 0.2;      // seconds the playhead takes to cover ~2/3 of the gap to the scroll (on top of smooth.js's glide)
const FILM_PUSH = 0.08;      // how far the picture zooms in over the whole film (8%)
const FILM_DRIFT = 70;       // px a caption drifts across its stretch of the scroll
const FILM_GPU_BUDGET = 96 * 1024 * 1024; // bytes of frames kept on the graphics chip
const FILM_UPLOAD_MS = 11;   // idle time to have in hand before putting a frame on the chip
const FILM_PARALLEL = 6;     // frames downloading at once
const FILM_DECODERS = 2;     // frames unpacking at once

// Draws a frame to fill the canvas, cropped like CSS object-fit: cover and
// zoomed in by the crop, with the next frame blended over it by `amount`.
const FILM_VERTEX = `
attribute vec2 corner;
uniform vec2 crop;
varying vec2 uv;
varying vec2 screen;
void main() {
  uv = vec2(0.5 + corner.x * 0.5 * crop.x, 0.5 - corner.y * 0.5 * crop.y);
  screen = corner * 0.5 + 0.5;
  gl_Position = vec4(corner, 0.0, 1.0);
}`;
// While the glitch layer fires (glitch.js), short dashes of the picture
// against the left and right edges are pushed sideways with their colours
// split into red and cyan fringes; the middle of the picture is left alone.
const FILM_FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D behind;
uniform sampler2D ahead;
uniform float amount;
uniform float glitch;
uniform float seed;
varying vec2 uv;
varying vec2 screen;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec4 frame(vec2 at) {
  return mix(texture2D(behind, at), texture2D(ahead, at), amount);
}
void main() {
  if (glitch > 0.0) {
    float band = floor(screen.y * (24.0 + 40.0 * hash(vec2(seed, 3.0))));
    if (hash(vec2(band, seed)) < 0.5 * glitch) {
      float reach = 0.03 + 0.17 * hash(vec2(band, seed + 3.0));
      bool fromLeft = hash(vec2(band, seed + 4.0)) < 0.5;
      if (fromLeft ? screen.x < reach : screen.x > 1.0 - reach) {
        vec2 at = vec2(uv.x + (hash(vec2(band, seed + 1.0)) - 0.5) * reach, uv.y);
        float split = 0.006 + 0.014 * glitch;
        gl_FragColor = vec4(frame(at + vec2(split, 0.0)).r, frame(at).g, frame(at - vec2(split, 0.0)).b, 1.0);
        return;
      }
    }
  }
  gl_FragColor = frame(uv);
}`;

// Runs `job` when the browser has nothing else to do. Safari has no
// requestIdleCallback: there, give it one frame's worth of time per turn.
function filmWhenIdle(job) {
  if (window.requestIdleCallback) return window.requestIdleCallback(job, { timeout: 250 });
  return setTimeout(() => {
    const end = performance.now() + FILM_UPLOAD_MS + 1;
    job({ didTimeout: false, timeRemaining: () => Math.max(0, end - performance.now()) });
  }, 16);
}

function initFilm() {
  const section = document.getElementById('film');
  if (!section) return;
  const saveData = navigator.connection && navigator.connection.saveData;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || saveData) return;

  const stage = section.querySelector('.film-stage');
  const canvas = section.querySelector('.film-canvas');
  const dim = section.querySelector('.film-dim');
  const header = document.querySelector('header.site-nav');
  const portrait = window.matchMedia('(orientation: portrait)');
  const gray = 'gray' in section.dataset;
  const beats = [...section.querySelectorAll('[data-beat]')].map((el) => {
    const [from, to] = el.dataset.beat.split(',').map(Number);
    // Where the caption sits still: the opening text at the start of its
    // stretch, the closing text at the end, anything else in the middle.
    const rest = from <= 0 ? 0 : to >= 1 ? 1 : 0.5;
    return { el, from, to, rest, style: '', out: true };
  });

  // Transparent until the first frame is drawn, so the poster shows through.
  const gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false });
  if (!gl) return;
  let glsl = null;     // the compiled program and where its inputs live

  let cut = null;      // the frames for the current orientation
  let navH = 0;        // the header's height: where the stage sticks
  let target = 0;      // where the scroll puts the playhead, in frames
  let current = 0;     // where the playhead is: it glides toward target
  let centre = -1;     // the frame the kept frames were last centred on
  let drawn = '';      // what is on the canvas, to skip redrawing the same
  let last = 0;        // time of the previous animation frame
  let running = false;
  let scrolling = false; // a scroll in the last moment: see tick()
  let settle = 0;

  /* ---- graphics chip ---- */

  function setUpGl() {
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('film:', gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, FILM_VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FILM_FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);

    // One rectangle covering the whole canvas, as a strip of two triangles.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, 'corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(gl.getUniformLocation(program, 'behind'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'ahead'), 1);
    // Frames are opaque and stored top row first: upload them as they are.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    return {
      crop: gl.getUniformLocation(program, 'crop'),
      amount: gl.getUniformLocation(program, 'amount'),
      glitch: gl.getUniformLocation(program, 'glitch'),
      seed: gl.getUniformLocation(program, 'seed'),
    };
  }

  // A black-and-white frame goes up as one byte a pixel instead of four: a
  // quarter of the memory, and the quickest to upload.
  function upload(frame) {
    const format = gray ? gl.LUMINANCE : gl.RGBA;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, format, gl.UNSIGNED_BYTE, frame);
    return tex;
  }

  /* ---- frames ---- */

  // Coarse to fine: every 16th frame first, then the ones between, and so
  // on. An early scroll already moves through the whole film, fading
  // between the frames that are in, and the gaps fill as the rest arrives.
  function loadOrder(count) {
    const order = [];
    const taken = new Set();
    for (let step = 16; step >= 1; step /= 2) {
      for (let i = 0; i < count; i += step) {
        if (!taken.has(i)) { taken.add(i); order.push(i); }
      }
    }
    return order;
  }

  function useCut() {
    const dir = portrait.matches ? 'tall' : 'wide';
    if (cut && cut.dir === dir) return;
    // A rotated phone switches cut: let go of the old one's frames.
    if (cut) {
      for (const tex of cut.ready.values()) gl.deleteTexture(tex);
      for (const frame of cut.decoded.values()) if (frame.close) frame.close();
    }
    const count = Number(section.dataset[dir]);
    cut = {
      dir, count,
      w: 0, h: 0,
      keep: 8,                // frames kept either side of the playhead, until the size is known
      packed: new Array(count), // the downloaded files
      decoded: new Map(),     // unpacked, waiting for idle time to go on the chip
      ready: new Map(),       // on the chip
      unpacking: new Set(),
      uploadQueued: false,
    };
    centre = -1;
    drawn = '';
    const mine = cut;
    const queue = loadOrder(count);
    let active = 0;
    const pump = () => {
      while (cut === mine && active < FILM_PARALLEL && queue.length) {
        const i = queue.shift();
        active++;
        fetch(`${section.dataset.film}/${dir}/f${String(i + 1).padStart(3, '0')}.webp`)
          .then((res) => (res.ok ? res.blob() : Promise.reject(res.status)))
          .then((blob) => { mine.packed[i] = blob; fill(); })
          .catch(() => { /* a missing frame: its neighbours stand in for it */ })
          .finally(() => { active--; pump(); });
      }
    };
    pump();
  }

  // An ImageBitmap, decoded off the main thread, where the browser can make
  // one from the file; otherwise an <img>, decoded ahead the same way.
  function unpack(blob) {
    return Promise.resolve()
      .then(() => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .catch(() => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.src = url;
        return img.decode().then(() => img).finally(() => URL.revokeObjectURL(url));
      });
  }

  // Works toward having every frame within `keep` of the playhead on the
  // chip: lets go of frames that have fallen outside that, and unpacks the
  // nearest missing ones (ahead of the playhead, the way the scroll is
  // going, before those behind) a couple at a time, never running more
  // than a few frames ahead of the uploads.
  function fill() {
    const mine = cut;
    if (!glsl) return;
    centre = Math.round(current);
    const kept = (i) => Math.abs(i - centre) <= mine.keep;
    for (const [i, tex] of mine.ready) if (!kept(i)) { gl.deleteTexture(tex); mine.ready.delete(i); }
    for (const [i, frame] of mine.decoded) if (!kept(i)) { if (frame.close) frame.close(); mine.decoded.delete(i); }

    const ahead = target >= current ? 1 : -1;
    for (let d = 0; d <= mine.keep; d++) {
      for (const i of d === 0 ? [centre] : [centre + d * ahead, centre - d * ahead]) {
        if (mine.unpacking.size >= FILM_DECODERS || mine.decoded.size >= FILM_DECODERS * 2) return;
        if (i < 0 || i >= mine.count || !mine.packed[i]) continue;
        if (mine.ready.has(i) || mine.decoded.has(i) || mine.unpacking.has(i)) continue;
        mine.unpacking.add(i);
        unpack(mine.packed[i])
          .then((frame) => {
            if (cut !== mine) { if (frame.close) frame.close(); return; }
            mine.decoded.set(i, frame);
            uploadWhenIdle();
          })
          .catch(() => { /* undecodable: its neighbours stand in for it */ })
          .finally(() => { mine.unpacking.delete(i); if (cut === mine) fill(); });
      }
    }
  }

  // Puts unpacked frames on the chip, nearest the playhead first, only
  // while the page has the idle time to spare for it.
  function uploadWhenIdle() {
    const mine = cut;
    if (mine.uploadQueued) return;
    mine.uploadQueued = true;
    filmWhenIdle((deadline) => {
      mine.uploadQueued = false;
      if (cut !== mine || !glsl) return;
      let added = false;
      while (mine.decoded.size && (deadline.didTimeout || deadline.timeRemaining() > FILM_UPLOAD_MS)) {
        let next = -1;
        for (const i of mine.decoded.keys()) {
          if (next === -1 || Math.abs(i - current) < Math.abs(next - current)) next = i;
        }
        const frame = mine.decoded.get(next);
        mine.decoded.delete(next);
        if (!mine.w) {
          mine.w = frame.width;
          mine.h = frame.height;
          // As many frames as the budget holds, half each side of the playhead.
          mine.keep = Math.floor(FILM_GPU_BUDGET / (mine.w * mine.h * (gray ? 1 : 4)) / 2);
        }
        mine.ready.set(next, upload(frame));
        if (frame.close) frame.close();
        added = true;
        if (deadline.didTimeout) break; // overdue, so one now, the rest at the next idle moment
      }
      if (added) { drawn = ''; wake(); }
      if (mine.decoded.size) uploadWhenIdle();
      fill();
    });
  }

  // The playhead usually sits between two frames: blend from the one behind
  // it to the one ahead, by how close it is to that one. When a frame isn't
  // ready yet, the nearest ones either side that are do the same job, so
  // the film fades across the gap instead of freezing.
  function drawAt(f, zoom) {
    let a = Math.floor(f);
    let b = Math.ceil(f);
    while (a >= 0 && !cut.ready.has(a)) a--;
    while (b < cut.count && !cut.ready.has(b)) b++;
    if (a < 0 && b >= cut.count) return; // nothing ready yet: the poster shows
    if (a < 0) a = b;
    if (b >= cut.count) b = a;
    const mix = a === b ? 0 : (f - a) / (b - a);
    const tear = typeof glitchState !== 'undefined' ? glitchState : { level: 0, seed: 0 };
    const key = `${a}/${b}/${mix.toFixed(3)}/${zoom.toFixed(4)}/${tear.level}/${tear.seed}`;
    if (key === drawn) return;
    drawn = key;
    gl.uniform1f(glsl.glitch, tear.level);
    gl.uniform1f(glsl.seed, tear.seed);

    // How much of the frame shows, as a fraction of it across and down:
    // like object-fit: cover, the side that overflows is cropped evenly.
    const screen = canvas.width / canvas.height;
    const frame = cut.w / cut.h;
    const across = screen < frame ? screen / frame : 1;
    const down = screen < frame ? 1 : frame / screen;
    gl.uniform2f(glsl.crop, across / zoom, down / zoom);
    gl.uniform1f(glsl.amount, mix);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cut.ready.get(a));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, cut.ready.get(b));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ---- layout ---- */

  // The stage sticks just below the header, so measure it: the header is a
  // different height on phones, and the ticker's height follows its font.
  function measure() {
    navH = header ? header.offsetHeight : 0;
    document.documentElement.style.setProperty('--nav-h', `${navH}px`);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(stage.clientWidth * ratio);
    const h = Math.round(stage.clientHeight * ratio);
    // A phone's address bar showing or hiding fires resize without changing
    // the stage; resizing the canvas anyway would blank it for a frame.
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    drawn = '';
  }

  // Also notes whether the film fills the screen below the header: the
  // galaxy behind it (galaxy.js) is hidden meanwhile, since the graphics
  // chip would otherwise keep compositing a sky nobody can see, under every
  // frame of the film.
  let covering = null;
  function progress() {
    const rect = section.getBoundingClientRect();
    const covers = rect.top <= navH + 1 && rect.bottom >= window.innerHeight - 1;
    if (covers !== covering) {
      covering = covers;
      document.documentElement.classList.toggle('film-covers', covers);
    }
    const travel = rect.height - stage.offsetHeight;
    return travel > 0 ? Math.min(Math.max((navH - rect.top) / travel, 0), 1) : 0;
  }

  /* ---- each animation frame ---- */

  function render() {
    const p = cut.count > 1 ? current / (cut.count - 1) : 0;
    if (glsl) drawAt(current, 1 + FILM_PUSH * p);

    for (const b of beats) {
      const fadeIn = b.from <= 0 ? 1 : (p - b.from) / FILM_FADE;
      const fadeOut = b.to >= 1 ? 1 : (b.to - p) / FILM_FADE;
      const o = Math.round(Math.min(Math.max(Math.min(fadeIn, fadeOut), 0), 1) * 100) / 100;
      const along = Math.min(Math.max((p - b.from) / (b.to - b.from), 0), 1);
      const y = Math.round((b.rest - along) * FILM_DRIFT);
      const style = `${o}/${y}`;
      if (style === b.style) continue;
      b.style = style;
      b.el.style.opacity = o;
      b.el.style.transform = `translateY(${y}px)`;
      // Hidden, not just transparent, so a faded-out button can't be
      // clicked or tabbed to.
      b.el.style.visibility = o === 0 ? 'hidden' : 'visible';
      if (b.el.classList.contains('film-intro') && dim) dim.style.opacity = o;
      // Tell the page a caption has come in (js/glitch.js decodes it).
      if (b.out && o > 0) b.el.dispatchEvent(new CustomEvent('film:beat', { bubbles: true }));
      b.out = o === 0;
    }
  }

  function tick(now) {
    // Ease toward the scroll position at the same pace whatever the
    // screen's refresh rate, and stop once there, so nothing runs while
    // the page is still. Once the scroll stops, settle on the nearest whole
    // frame: left between two frames either side of a cut, the still
    // would be a double exposure of two different shots.
    const goal = scrolling ? target : Math.round(target);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    current += (goal - current) * (1 - Math.exp(-dt / FILM_GLIDE));
    if (Math.abs(goal - current) < 0.01) current = goal;
    if (Math.round(current) !== centre) fill();
    render();
    if (current !== goal) requestAnimationFrame(tick);
    else running = false;
  }

  function wake() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function onScroll() {
    target = progress() * (cut.count - 1);
    scrolling = true;
    clearTimeout(settle);
    settle = setTimeout(() => { scrolling = false; wake(); }, 150);
    wake();
  }

  // The graphics chip can drop the canvas (a driver reset, or a phone
  // reclaiming memory): show the poster until it comes back, then rebuild
  // and put the frames back on it.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    glsl = null;
    canvas.style.visibility = 'hidden';
  });
  canvas.addEventListener('webglcontextrestored', () => {
    glsl = setUpGl();
    if (!glsl) return;
    cut.ready.clear(); // those textures went with the old context
    gl.viewport(0, 0, canvas.width, canvas.height);
    canvas.style.visibility = '';
    drawn = '';
    fill();
    if (cut.decoded.size) uploadWhenIdle();
  });

  glsl = setUpGl();
  if (!glsl) return;
  section.classList.add('is-live');
  measure();
  useCut();
  // Start where the page is (a reload halfway down, say) rather than
  // gliding there from the top.
  target = progress() * (cut.count - 1);
  current = Math.round(target);
  render();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { measure(); onScroll(); });
  // Redraw with each new tear pattern while the glitch layer fires.
  if (typeof onGlitch === 'function') onGlitch(() => { drawn = ''; wake(); });
  portrait.addEventListener('change', () => {
    useCut();
    measure();
    target = progress() * (cut.count - 1);
    current = Math.round(target);
    wake();
  });
}
