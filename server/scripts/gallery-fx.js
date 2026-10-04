'use strict';
// Styled versions of gallery photos, for the editorial sections around the
// site (css "editorial" block in store.css, js/editorial.js):
//   smear   the photo graded to two tones, with rows dragged sideways into
//           streaks of motion blur and a little film grain
//   trail   the photo at the right of a wide frame, its streaks dragged out
//           across the empty left side (page headers: text goes on the left)
//   banner  several photos side by side, smeared into one another
//   cutout  the person cut out of the photo, in black and white (posters)
//   mono    the photo in grainy black and white (insets on the posters)
//
//   node scripts/gallery-fx.js [name …]
//
// Reads the gallery's own photos (assets/gallery/<id>-1280.webp, made by
// gallery-build.js), so it works from a fresh checkout. Writes
// assets/gallery/fx/<name>.webp. With names, makes just those. Cutouts need
// Python with rembg (see gallery-cutout.py); they're kept between runs, so
// only new ones need it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const GALLERY = path.join(__dirname, '..', '..', 'storefront', 'assets', 'gallery');
const OUT = path.join(GALLERY, 'fx');
// the cut-outs straight from rembg, kept out of the site (and git) so a
// re-run only cuts new ones
const CUTS = path.join(__dirname, '..', '..', 'media-inbox', 'fx-cuts');

/* ---------------- what gets made ----------------
   from: the gallery id(s). Sizes are the output's, in pixels. focus moves
   the crop (0 = top/left, 1 = bottom/right). */
const FX = {
  // page headers
  'hero-shop': { look: 'trail', from: 'painted-2024-10-31-dbzxvuboq9m-1', size: [2000, 900], seed: 3, focus: [0.5, 0.45] },
  'hero-story': { look: 'trail', from: 'events-2025-07-15-dmicjuznsit-2', size: [2000, 900], seed: 7, focus: [0.5, 0.35] },
  'hero-visit': { look: 'trail', from: 'shop-2026-08-09-db1wrkhdz-x-2', size: [2000, 900], seed: 11, focus: [0.5, 0.5] },
  'hero-contact': { look: 'trail', from: 'crew-2025-08-28-dn6nb-5dffk-1', size: [2000, 900], seed: 5, focus: [0.5, 0.4] },
  'hero-gallery': { look: 'banner', from: ['crew-2023-07-18-cu2tcsyou7r-2', 'events-2025-07-15-dmicjuznsit-1', 'alien-2026-07-19-da-nzcickxs-2', 'crew-2021-12-21-cxwwt2amlg2-2', 'crew-2025-12-08-dsbda7cdx-l-2'], size: [2400, 900], seed: 21 },
  'lost': { look: 'smear', from: 'painted-2021-12-05-cxgphfysods-1', size: [1200, 1500], seed: 9, amount: 0.75 },

  // home: four worlds to pick from
  'tile-alien': { look: 'smear', from: 'alien-2026-07-19-da-nzcickxs-7', size: [900, 1200], seed: 31 },
  'tile-painted': { look: 'smear', from: 'painted-2025-07-23-dmdvem3ndzc-1', size: [900, 1200], seed: 32 },
  'tile-crew': { look: 'smear', from: 'events-2025-07-15-dmicjuznsit-1', size: [900, 1200], seed: 33 },
  'tile-shop': { look: 'smear', from: 'shop-2026-08-09-db1wrkhdz-x-1', size: [900, 1200], seed: 34 },

  // home: the split statement, and the banner near the bottom
  'split-stand': { look: 'trail', from: 'crew-2026-09-10-ddg-tmbdbl--1', size: [1600, 1100], seed: 41, focus: [0.5, 0.3], side: 0.5 },
  'banner-reckless': { look: 'banner', from: ['crew-2021-12-21-cxwwt2amlg2-1', 'events-2025-07-15-dmicjuznsit-2', 'crew-2026-09-10-ddg-tmbdbl--7', 'crew-2023-07-18-cu2tcsyou7r-1', 'crew-2021-11-17-cww8darqmvn-1'], size: [2400, 1000], seed: 51 },

  // posters
  'cut-reckless': { look: 'cutout', from: 'crew-2026-09-10-ddg-tmbdbl--7' },
  'cut-gang': { look: 'cutout', from: 'painted-2024-08-15-c-s7o1loeyl-1' },
  'cut-visor': { look: 'cutout', from: 'painted-2021-12-05-cxgphfysods-1' },
};

/* ---------------- a little noise ---------------- */

// mulberry32: the same seed always gives the same picture
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// smooth 1D noise, 0..1
function wave(seed) {
  const r = random(seed);
  const pts = Float32Array.from({ length: 1024 }, r);
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return pts[i & 1023] + (pts[(i + 1) & 1023] - pts[i & 1023]) * u;
  };
}

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

/* ---------------- the looks ---------------- */

// Night blue, like a photo left out under a streetlight: black, navy,
// electric blue, ice. Warm things (skin, red cloth) keep an ember of orange.
const NIGHT = [[0, [4, 6, 14]], [0.28, [14, 30, 74]], [0.58, [52, 108, 214]], [0.84, [168, 200, 250]], [1, [238, 244, 255]]];
const EMBER = [255, 92, 40];

function tone(l) {
  for (let i = 1; i < NIGHT.length; i++) {
    if (l <= NIGHT[i][0]) {
      const [a, ca] = NIGHT[i - 1];
      const [b, cb] = NIGHT[i];
      const t = (l - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return NIGHT[NIGHT.length - 1][1];
}

// How hard each row is dragged (0..1), how far it trails and how far it's
// shoved sideways: patches of calm and patches of streaks, in bands from a
// pixel to a few dozen tall, so the edges come out jagged like a
// photocopier dragged mid-scan, not blurred.
function rowField(h, seed, amount) {
  const r = random(seed);
  const big = wave(seed + 1);
  const mid = wave(seed + 2);
  const strength = new Float32Array(h);
  const reach = new Float32Array(h);
  const shift = new Float32Array(h);
  let y = 0;
  while (y < h) {
    const band = 1 + Math.floor(r() * r() * r() * 60);
    const kick = r();
    const far = 0.25 + 0.75 * Math.pow(r(), 0.7);
    const shove = r() > 0.8 ? (r() * 2 - 1) : 0;
    for (let k = 0; k < band && y < h; k++, y++) {
      const field = big(y / 160) * 0.6 + mid(y / 34) * 0.4;
      const s = clamp((field - (1 - amount)) / amount);
      strength[y] = clamp(s * (kick < 0.2 ? 0.2 : kick > 0.75 ? 1.6 : 1));
      reach[y] = far;
      shift[y] = shove * s;
    }
  }
  return { strength, reach, shift };
}

// Drag each row toward `dir` (-1: trails run left): shove it sideways a
// little, then smear it with a fading trail — red trails a little longer
// than blue, so the streaks fringe orange and blue. Only the trailing side
// smears; `lead` (a share of the width) on the side it's moving toward
// stays sharp, so it reads as something moving fast, not a broken image.
function smearPixels(px, w, h, { seed, amount = 0.6, trail = 0.3, dir = -1, lead = 0.3, ghost = 0 }) {
  const { strength, reach, shift } = rowField(h, seed, amount);
  const out = new Float32Array(w * h * 3);
  const row = new Float32Array(w * 3);
  const ramp = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const t = dir < 0 ? x / w : 1 - x / w; // 0 at the trailing edge
    ramp[x] = clamp((1 - lead - t) / (1 - lead) * 1.6 + 0.12);
  }
  const maxShift = w * 0.06;
  const maxTrail = w * trail;
  // a double exposure: the frame again, a step behind, over the trailing side
  const step = Math.round(-dir * w * 0.07);
  for (let y = 0; y < h; y++) {
    const s = strength[y];
    const off = shift[y] * maxShift;
    for (let x = 0; x < w; x++) {
      const sx = clamp(Math.round(x + off * ramp[x]), 0, w - 1);
      const i = (y * w + sx) * 3;
      row[x * 3] = px[i]; row[x * 3 + 1] = px[i + 1]; row[x * 3 + 2] = px[i + 2];
      if (ghost) {
        const g = (y * w + clamp(sx + step, 0, w - 1)) * 3;
        const k = ghost * ramp[x] * (0.35 + 0.65 * s);
        for (let c = 0; c < 3; c++) row[x * 3 + c] += (Math.max(px[g + c], row[x * 3 + c]) - row[x * 3 + c]) * k;
      }
    }
    const len = 1 + s * reach[y] * maxTrail;
    const keep = [Math.exp(-1 / (len * 1.35)), Math.exp(-1 / len), Math.exp(-1 / (len * 0.7))];
    const start = dir < 0 ? (w - 1) * 3 : 0;
    const acc = [row[start], row[start + 1], row[start + 2]];
    for (let n = 0; n < w; n++) {
      const x = dir < 0 ? w - 1 - n : n;
      const o = (y * w + x) * 3;
      const mixIn = clamp(s * ramp[x] * 1.15);
      for (let c = 0; c < 3; c++) {
        const v = row[x * 3 + c];
        acc[c] = acc[c] * keep[c] + v * (1 - keep[c]);
        out[o + c] = v + (acc[c] - v) * mixIn;
      }
    }
  }
  return out;
}

function grade(px, w, h, seed, { grain = 14, ember = 0.55, vignette = 0.35 } = {}) {
  const r = random(seed + 99);
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const R = px[i], G = px[i + 1], B = px[i + 2];
      let l = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
      l = l * l * (3 - 2 * l) * 0.75 + l * 0.25; // a bit more contrast
      const dx = x / w - 0.5;
      const dy = y / h - 0.5;
      l *= 1 - vignette * (dx * dx + dy * dy) * 1.6;
      const c = tone(clamp(l));
      const warm = clamp((R - B) / 140 - 0.15) * ember * clamp(l * 2.2);
      const g = (r() - 0.5) * grain;
      for (let k = 0; k < 3; k++) out[i + k] = clamp(c[k] + (EMBER[k] - c[k]) * warm + g, 0, 255);
    }
  }
  return out;
}

async function load(id, [w, h], focus = [0.5, 0.5]) {
  const src = path.join(GALLERY, `${id}-1280.webp`);
  const meta = await sharp(src).metadata();
  // cover-crop to the frame, with the focus point kept in view
  const scale = Math.max(w / meta.width, h / meta.height);
  const sw = Math.round(meta.width * scale);
  const sh = Math.round(meta.height * scale);
  const left = Math.round(clamp(focus[0]) * (sw - w));
  const top = Math.round(clamp(focus[1]) * (sh - h));
  const { data } = await sharp(src).resize(sw, sh).extract({ left, top, width: w, height: h })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return Float32Array.from(data);
}

async function save(name, buf, w, h, quality = 72) {
  const file = path.join(OUT, `${name}.webp`);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).webp({ quality }).toFile(file);
  return file;
}

const LOOKS = {
  async smear(name, fx) {
    const [w, h] = fx.size;
    const px = await load(fx.from, fx.size, fx.focus);
    const out = grade(smearPixels(px, w, h, { seed: fx.seed, amount: fx.amount || 0.72, trail: 0.4, lead: 0.22, ghost: fx.ghost ?? 0.5 }), w, h, fx.seed);
    return save(name, out, w, h);
  },

  // The photo fills a share of the frame on the right (fx.side, default
  // 0.42); every row of its left edge is dragged out across the rest,
  // fading into the night at its own length.
  async trail(name, fx) {
    const [w, h] = fx.size;
    const pw = Math.round(w * (fx.side || 0.42));
    const amount = 0.65;
    const photo = await load(fx.from, [pw, h], fx.focus);
    const smeared = smearPixels(photo, pw, h, { seed: fx.seed, amount, trail: 0.45, lead: 0.5 });
    // the same bands as the photo's own smear, so its streaks carry on out
    const { strength, reach } = rowField(h, fx.seed, amount);
    const px = new Float32Array(w * h * 3);
    const night = [4, 6, 14];
    const x0 = w - pw;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < pw; x++) {
        const i = (y * pw + x) * 3;
        const o = (y * w + x0 + x) * 3;
        px[o] = smeared[i]; px[o + 1] = smeared[i + 1]; px[o + 2] = smeared[i + 2];
      }
      // a few rows streak most of the way across; most die out quickly
      const len = x0 * (0.02 + 0.98 * Math.pow(strength[y] * reach[y], 1.6));
      const keep = Math.exp(-1 / Math.max(len, 1));
      const edge = (y * pw) * 3;
      const a = [smeared[edge], smeared[edge + 1], smeared[edge + 2]];
      for (let x = x0 - 1; x >= 0; x--) {
        const o = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          a[c] = a[c] * keep + night[c] * (1 - keep);
          px[o + c] = a[c];
        }
      }
    }
    return save(name, grade(px, w, h, fx.seed, { vignette: 0.15 }), w, h);
  },

  // Photos in overlapping columns, faded into one another and smeared.
  async banner(name, fx) {
    const [w, h] = fx.size;
    const n = fx.from.length;
    const slot = w / n;
    const cw = Math.ceil(slot * 1.4); // each overlaps its neighbours
    const px = new Float32Array(w * h * 3);
    const weight = new Float32Array(w * h);
    for (let k = 0; k < n; k++) {
      const col = await load(fx.from[k], [cw, h], [0.5, 0.35]);
      const left = Math.round(k * slot - (cw - slot) / 2);
      for (let x = 0; x < cw; x++) {
        const X = left + x;
        if (X < 0 || X >= w) continue;
        const f = Math.sin(Math.PI * (x + 0.5) / cw); // fades out at both sides
        const wgt = f * f * f;
        for (let y = 0; y < h; y++) {
          const i = (y * cw + x) * 3;
          const o = y * w + X;
          px[o * 3] += col[i] * wgt; px[o * 3 + 1] += col[i + 1] * wgt; px[o * 3 + 2] += col[i + 2] * wgt;
          weight[o] += wgt;
        }
      }
    }
    for (let o = 0; o < w * h; o++) {
      const k = weight[o] || 1;
      px[o * 3] /= k; px[o * 3 + 1] /= k; px[o * 3 + 2] /= k;
    }
    const out = grade(smearPixels(px, w, h, { seed: fx.seed, amount: 0.55, trail: 0.16, lead: 0.15 }), w, h, fx.seed);
    return save(name, out, w, h);
  },

  // The person on transparency, in hard black and white with grain. The
  // cut is the slow part, so it's kept and reused.
  async cutout(name, fx) {
    fs.mkdirSync(CUTS, { recursive: true });
    const cut = path.join(CUTS, `${fx.from}.png`);
    if (!fs.existsSync(cut)) {
      execFileSync('python', [path.join(__dirname, 'gallery-cutout.py'),
        path.join(GALLERY, `${fx.from}-1280.webp`), cut], { stdio: 'inherit' });
    }
    // trim to the person, then grade the colour (the alpha rides along)
    const { data, info } = await sharp(cut).trim({ threshold: 1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = random(7);
    for (let i = 0; i < data.length; i += 4) {
      let l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      l = clamp((l - 0.5) * 1.35 + 0.52);
      l = clamp(l + (r() - 0.5) * 0.07);
      data[i] = data[i + 1] = data[i + 2] = Math.round(l * 255);
    }
    const file = path.join(OUT, `${name}.webp`);
    await sharp(data, { raw: info }).webp({ quality: 80, alphaQuality: 90 }).toFile(file);
    return file;
  },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const names = process.argv.slice(2);
  for (const name of names.length ? names : Object.keys(FX)) {
    const fx = FX[name];
    if (!fx) throw new Error(`no such fx: ${name}`);
    const file = await LOOKS[fx.look](name, fx);
    const { size } = fs.statSync(file);
    console.log(`${name}  ${(size / 1024).toFixed(0)} KB`);
  }
})().catch((err) => { console.error(err); process.exit(1); });
