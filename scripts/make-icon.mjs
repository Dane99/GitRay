/**
 * Generates the marketplace icon, media/icon.png.
 *
 * Written as a script rather than a checked-in binary nobody can edit: the icon is the
 * extension's visual language in miniature — a collaborator's ray, signal arcs radiating
 * from it, and the one warm diamond that means your work and theirs have met — so it
 * should stay editable alongside the palette it borrows from.
 *
 * No image dependencies. PNG is a container around zlib-compressed scanlines, and Node
 * ships zlib, so the whole encoder is about thirty lines. Anti-aliasing comes from
 * supersampling at 4x and box-filtering down.
 *
 *   node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const SS = 4; // supersampling factor
const W = SIZE * SS;

// Straight from src/ui/colors.ts, so the icon and the gutter agree.
const BACKGROUND = [0x13, 0x1a, 0x26];
const RAY = [0x4a, 0xa8, 0xff];
const COLLISION = [0xff, 0xa6, 0x57];

const s = (n) => n * SS;
const CENTER_X = s(72);
const CENTER_Y = s(128);

/** Rounded-rectangle hit test: clamp to the inner rect, then measure the corner radius. */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** A band of an arc centred on the ray, opening to the right. */
function inArc(x, y, radius, thickness, halfAngle) {
  const dx = x - CENTER_X;
  const dy = y - CENTER_Y;
  const distance = Math.hypot(dx, dy);
  if (Math.abs(distance - radius) > thickness / 2) return false;
  return Math.abs(Math.atan2(dy, dx)) <= halfAngle;
}

function inDiamond(x, y, cx, cy, halfWidth, halfHeight) {
  return Math.abs(x - cx) / halfWidth + Math.abs(y - cy) / halfHeight <= 1;
}

/** Layers, bottom to top. Each returns [r, g, b, alpha] or null. */
function sample(x, y) {
  const layers = [];

  if (inRoundRect(x, y, 0, 0, W, W, s(56))) {
    layers.push([...BACKGROUND, 1]);
  }

  // Signal arcs fading outward.
  for (const [radius, thickness, alpha] of [
    [s(52), s(11), 0.9],
    [s(84), s(11), 0.55],
    [s(116), s(11), 0.3]
  ]) {
    if (inArc(x, y, radius, thickness, 0.95)) layers.push([...RAY, alpha]);
  }

  // The ray itself.
  if (inRoundRect(x, y, s(44), s(56), s(60), s(200), s(8))) {
    layers.push([...RAY, 1]);
  }

  // Where a collaborator's change meets yours.
  if (inDiamond(x, y, CENTER_X + s(84), CENTER_Y, s(21), s(26))) {
    layers.push([...COLLISION, 1]);
  }

  // Composite source-over, in premultiplied space.
  let [r, g, b, a] = [0, 0, 0, 0];
  for (const [lr, lg, lb, la] of layers) {
    r = (lr / 255) * la + r * (1 - la);
    g = (lg / 255) * la + g * (1 - la);
    b = (lb / 255) * la + b * (1 - la);
    a = la + a * (1 - la);
  }
  return [r, g, b, a];
}

// --- Render, with a box filter down from the supersampled grid ---------------------

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(px * SS + sx + 0.5, py * SS + sy + 0.5);
        r += sr;
        g += sg;
        b += sb;
        a += sa;
      }
    }

    const n = SS * SS;
    const alpha = a / n;
    const offset = (py * SIZE + px) * 4;
    // Un-premultiply so the stored colour is correct at partial coverage.
    const unmul = alpha > 0 ? 1 / alpha : 0;
    pixels[offset] = Math.round(Math.min(1, (r / n) * unmul) * 255);
    pixels[offset + 1] = Math.round(Math.min(1, (g / n) * unmul) * 255);
    pixels[offset + 2] = Math.round(Math.min(1, (b / n) * unmul) * 255);
    pixels[offset + 3] = Math.round(alpha * 255);
  }
}

// --- Encode PNG --------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // truecolour with alpha
// bytes 10-12: deflate compression, adaptive filtering, no interlace — all zero.

// Each scanline is prefixed with its filter type; 0 means "none".
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);

console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
