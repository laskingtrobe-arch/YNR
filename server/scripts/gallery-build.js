'use strict';
// Builds the gallery (storefront/gallery.html, js/gallery.js) from folders of
// photos and videos, each folder with a manifest.json describing its items:
//   [{ "group": "painted", "code": "Cx…", "date": "2026-07-19", "caption": "…",
//      "photos": ["a.jpg", …], "video": { "file": "b.mp4", "poster": "b.jpg" } }]
// (the manifest from an Instagram export, or one written by hand).
//   node scripts/gallery-build.js <folder> [<folder> …]
//
// Writes storefront/assets/gallery/: every photo as WebP in two widths
// (-800 for the grid, -1280 enlarged), every video re-encoded small for the
// web WITHOUT its soundtrack (Reels mostly use music licensed for Instagram
// only, and the gallery plays them silently anyway) with a WebP poster, and
// gallery.json listing them all, newest first. Needs ffmpeg on PATH.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', '..', 'storefront', 'assets', 'gallery');
const GROUPS = ['alien', 'painted', 'crew', 'shop', 'events', 'reels'];

// A caption fit for the site. Old posts quote prices and an old WhatsApp
// number that would mislead a customer today, so those go, along with
// hashtags and the decorations some captions are typed in (letters in
// boxes, strike-through marks, ░ blocks).
function tidy(caption) {
  return String(caption || '')
    .toWellFormed() // a caption cut off mid-emoji leaves half of it behind
    .replace(/�/g, '')
    .normalize('NFKC')
    .replace(/[҉░]/g, '')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '')                              // phone numbers
    .replace(/(?:₦|\bNGN|\bN)\s?\d[\d,.]*k?\b(?:\s*naira)?/gi, '')  // ₦18,000, N 17,500, N20k
    .replace(/\b(?:for\s+)?\d+(?:\.\d+)?k\b(?:\s*naira)?/gi, '')    // 18k, for 35k, 20k Naira
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

async function photo(src, id) {
  const sizes = {};
  for (const width of [800, 1280]) {
    const info = await sharp(src).rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: width === 800 ? 74 : 76 })
      .toFile(path.join(OUT, `${id}-${width}.webp`));
    sizes[width] = info;
  }
  return { w: sizes[800].width, h: sizes[800].height };
}

function video(src, id) {
  // 720px on the long side at most, H.264 for every browser, the index at
  // the front so it can start playing before it has all downloaded.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-an',
    '-vf', "scale='if(gt(iw,ih),min(720,iw),-2)':'if(gt(iw,ih),-2,min(720,ih))'",
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', path.join(OUT, `${id}.mp4`)]);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path.join(OUT, `${id}.mp4`)]);
  const meta = JSON.parse(probe);
  return { w: meta.streams[0].width, h: meta.streams[0].height, dur: Math.round(Number(meta.format.duration)) };
}

(async () => {
  const folders = process.argv.slice(2);
  if (!folders.length) {
    console.error('usage: node scripts/gallery-build.js <folder with manifest.json> [...]');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const items = [];
  for (const folder of folders) {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    for (const entry of manifest) {
      if (!GROUPS.includes(entry.group)) throw new Error(`unknown group "${entry.group}" in ${folder}`);
      const base = `${entry.group}-${entry.date}-${entry.code || 'x'}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const common = { group: entry.group, date: entry.date, caption: tidy(entry.caption), post: entry.code || null };
      for (const [n, file] of (entry.photos || []).entries()) {
        const id = `${base}-${n + 1}`;
        items.push({ id, type: 'photo', ...common, ...(await photo(path.join(folder, file), id)) });
      }
      if (entry.video && entry.video.file) {
        const id = `${base}-v`;
        const v = video(path.join(folder, entry.video.file), id);
        if (entry.video.poster) await photo(path.join(folder, entry.video.poster), `${id}-poster`);
        items.push({ id, type: 'video', ...common, ...v });
      }
      process.stdout.write('.');
    }
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  fs.writeFileSync(path.join(OUT, 'gallery.json'), `${JSON.stringify(items, null, 1)}\n`);
  const kb = fs.readdirSync(OUT).reduce((sum, f) => sum + fs.statSync(path.join(OUT, f)).size, 0) / 1024;
  console.log(`\n${items.length} items (${items.filter((i) => i.type === 'video').length} videos), ${Math.round(kb / 1024)} MB in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
