'use strict';
// Cuts a film into the still frames the home page draws as you scroll
// (storefront/js/film.js). Needs ffmpeg on PATH.
//   node scripts/film-frames.js <wide.mp4> <tall.mp4> <name> [--gray]
//   e.g. node scripts/film-frames.js ~/Downloads/ufo-wide.mp4 ~/Downloads/ufo-tall.mp4 ufo-v1 --gray
// <wide> is the landscape cut for computers, <tall> the portrait cut for
// phones. Writes storefront/assets/film/<name>/{wide,tall}/fNNN.webp.
//
// Give a changed film a new <name>: the server caches these frames for a
// year, so new frames under an old name would never reach returning visitors.
// --gray stores black-and-white footage as grayscale, which is smaller.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const gray = args.includes('--gray');
const [wideSrc, tallSrc, name] = args.filter((a) => !a.startsWith('--'));
if (!wideSrc || !tallSrc || !/^[a-z0-9-]+$/.test(name || '')) {
  console.error('usage: node scripts/film-frames.js <wide.mp4> <tall.mp4> <name, e.g. ufo-v1> [--gray]');
  process.exit(1);
}

// Every other frame (12 a second of film): half the download, and a scroll
// skips frames anyway. Many visitors are on mobile data, laptops on a phone
// hotspot included, so the weight matters more than the last bit of
// smoothness. Phones get a slightly lower quality on their smaller screens.
const SETS = [
  { dir: 'wide', src: wideSrc, width: 1280, step: 2, quality: 50 },
  { dir: 'tall', src: tallSrc, width: 720, step: 2, quality: 45 },
];

const outRoot = path.join(__dirname, '..', '..', 'storefront', 'assets', 'film', name);
if (fs.existsSync(outRoot)) {
  console.error(`${outRoot} already exists. Use a new name, or delete that folder first.`);
  process.exit(1);
}

for (const set of SETS) {
  const out = path.join(outRoot, set.dir);
  fs.mkdirSync(out, { recursive: true });
  const filters = [
    set.step > 1 && `select='not(mod(n\\,${set.step}))'`,
    `scale=${set.width}:-2:flags=lanczos`,
    gray && 'format=gray',
  ].filter(Boolean).join(',');
  execFileSync('ffmpeg', ['-v', 'error', '-i', set.src, '-vf', filters, '-fps_mode', 'vfr', '-an',
    '-c:v', 'libwebp', '-quality', String(set.quality), '-compression_level', '6',
    path.join(out, 'f%03d.webp')], { stdio: 'inherit' });
  const files = fs.readdirSync(out);
  const kb = files.reduce((sum, f) => sum + fs.statSync(path.join(out, f)).size, 0) / 1024;
  set.count = files.length;
  console.log(`${set.dir}: ${files.length} frames, ${Math.round(kb)} KB`);
}

console.log(`\nOn the page:\n  data-film="/assets/film/${name}" data-wide="${SETS[0].count}" data-tall="${SETS[1].count}"${gray ? ' data-gray' : ''}`);
