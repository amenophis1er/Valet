/*
 * The extension's mark, drawn here instead of committed as four binaries.
 *
 * A rounded teal square with the agent's pointer in it — the same arrow the
 * agent shows on the pages it works in — and, from 32 px up, a small sparkle.
 * Every pixel is sampled 4×4 times, so edges are smooth at 16 px and at 128.
 * Generating it keeps the repository free of binary assets nobody can diff;
 * nothing is fetched, at build time or after.
 */
import { deflateSync } from 'node:zlib';

/** Teal, lighter at the top left, deeper at the bottom right. */
const TOP = [0x14, 0xb8, 0xa6];
const BOTTOM = [0x0b, 0x5e, 0x58];
const INK = [0xff, 0xff, 0xff];
const SHADOW = [0x04, 0x2f, 0x2c];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

/** Rows of RGBA, one filter byte each, deflated: the whole of the PNG format we need. */
export function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const at = y * stride + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8 bits, truecolour with alpha.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The agent's arrow (panel.html and the in-page cursor), in a 22-unit box. */
const ARROW = [[2, 2], [2, 18], [7, 13.5], [10.5, 20], [13.5, 18.5], [10, 12], [17, 12]];

function inside(polygon, x, y) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A four-pointed sparkle centred at (cx, cy) with radius r: |dx|^½ + |dy|^½ ≤ r^½. */
function sparkle(x, y, cx, cy, r) {
  return Math.sqrt(Math.abs(x - cx)) + Math.sqrt(Math.abs(y - cy)) <= Math.sqrt(r);
}

const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);

export function icon(size) {
  const radius = 0.23;
  const small = size < 32;
  // The arrow in unit coordinates: bigger when there is little room, a little off centre towards the top left.
  const scale = small ? 0.042 : 0.036;
  const [ox, oy] = small ? [0.19, 0.1] : [0.2, 0.12];
  const arrow = ARROW.map(([x, y]) => [ox + x * scale, oy + y * scale]);
  const shadowShift = 0.022;
  const shadow = arrow.map(([x, y]) => [x + shadowShift * 0.4, y + shadowShift]);
  const N = 4;
  return png(size, (px, py) => {
    let alpha = 0;
    let color = [0, 0, 0];
    for (let sy = 0; sy < N; sy += 1) {
      for (let sx = 0; sx < N; sx += 1) {
        const u = (px + (sx + 0.5) / N) / size;
        const v = (py + (sy + 0.5) / N) / size;
        // The rounded square.
        const qx = Math.max(Math.abs(u - 0.5) - (0.5 - radius), 0);
        const qy = Math.max(Math.abs(v - 0.5) - (0.5 - radius), 0);
        if (Math.hypot(qx, qy) > radius) continue;
        let c = mix(TOP, BOTTOM, Math.min(1, Math.max(0, (u + v) / 2)));
        if (!small && inside(shadow, u, v)) c = mix(c, SHADOW, 0.35);
        if (inside(arrow, u, v)) c = INK;
        else if (!small && sparkle(u, v, 0.74, 0.27, 0.11)) c = mix(INK, TOP, 0.08);
        color = color.map((value, i) => value + c[i]);
        alpha += 1;
      }
    }
    if (alpha === 0) return [0, 0, 0, 0];
    return [...color.map((value) => Math.round(value / alpha)), Math.round((255 * alpha) / (N * N))];
  });
}

export const SIZES = [16, 32, 48, 128];
