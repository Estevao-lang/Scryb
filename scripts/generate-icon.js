/**
 * Generates public/icon.png — a 256×256 purple rounded-square logo for
 * use as the Electron window/taskbar icon (Windows requires PNG or ICO).
 * Pure Node.js, zero external dependencies.
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// ── CRC32 (required by PNG format) ───────────────────────────

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// ── PNG builder ───────────────────────────────────────────────

function buildPNG(width, height, getPixel) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  // compression, filter, interlace = 0

  // Raw scanlines (filter byte 0 = None per row)
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const i = 1 + x * 4;
      row[i] = r; row[i + 1] = g; row[i + 2] = b; row[i + 3] = a;
    }
    rows.push(row);
  }

  const idatData = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

  const makeChunk = (type, data) => {
    const typeBytes = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const body = Buffer.concat([typeBytes, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body));
    return Buffer.concat([lenBuf, body, crcBuf]);
  };

  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdrData),
    makeChunk("IDAT", idatData),
    makeChunk("IEND", Buffer.alloc(0))
  ]);
}

// ── Icon pixel function ───────────────────────────────────────

function iconPixel(x, y, size) {
  const r = size / 2;
  const cx = x - r + 0.5;
  const cy = y - r + 0.5;
  const cornerR = size * 0.22; // rounded corner radius

  // Rounded rectangle SDF
  const qx = Math.abs(cx) - (r - cornerR);
  const qy = Math.abs(cy) - (r - cornerR);
  const dist = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - cornerR;

  // Anti-aliased edge
  const alpha = Math.max(0, Math.min(1, 0.5 - dist));
  if (alpha <= 0) return [0, 0, 0, 0]; // transparent outside

  // Background gradient: top-left #7c5cfc → bottom-right #4a2fcf
  const t = (x + y) / (size * 2);
  const bgR = Math.round(0x7c + (0x4a - 0x7c) * t);
  const bgG = Math.round(0x5c + (0x2f - 0x5c) * t);
  const bgB = Math.round(0xfc + (0xcf - 0xfc) * t);

  // "S" letterform — drawn as two arcs approximated by filled regions
  const lx = (cx / r) * 0.55; // normalised -0.55..0.55
  const ly = (cy / r) * 0.55;
  let inLetter = false;

  // Top arc of S (upper half)
  if (ly < 0.04) {
    const arcCy = -0.2;
    const outerR = 0.28, innerR = 0.14;
    const d = Math.sqrt(lx ** 2 + (ly - arcCy) ** 2);
    if (d >= innerR && d <= outerR && !(lx < -0.04 && ly > arcCy)) inLetter = true;
  }
  // Bottom arc of S (lower half)
  if (ly > -0.04) {
    const arcCy = 0.2;
    const outerR = 0.28, innerR = 0.14;
    const d = Math.sqrt(lx ** 2 + (ly - arcCy) ** 2);
    if (d >= innerR && d <= outerR && !(lx > 0.04 && ly < arcCy)) inLetter = true;
  }
  // Middle bar
  if (Math.abs(ly) < 0.06 && Math.abs(lx) < 0.26) inLetter = true;

  const pR = inLetter ? 255 : bgR;
  const pG = inLetter ? 255 : bgG;
  const pB = inLetter ? 255 : bgB;

  // Cyan accent dot (top-right)
  const dotX = r * 0.58, dotY = -r * 0.58;
  const dotDist = Math.sqrt((cx - dotX) ** 2 + (cy - dotY) ** 2);
  const dotAlpha = Math.max(0, Math.min(1, r * 0.12 - dotDist));

  const fR = Math.round(pR * (1 - dotAlpha) + 0x00 * dotAlpha);
  const fG = Math.round(pG * (1 - dotAlpha) + 0xd4 * dotAlpha);
  const fB = Math.round(pB * (1 - dotAlpha) + 0xff * dotAlpha);

  return [fR, fG, fB, Math.round(alpha * 255)];
}

// ── Main ──────────────────────────────────────────────────────

const SIZE = 256;
const outPath = path.join(__dirname, "..", "public", "icon.png");

const png = buildPNG(SIZE, SIZE, (x, y) => iconPixel(x, y, SIZE));
fs.writeFileSync(outPath, png);
console.log(`[icon] generated ${outPath} (${SIZE}x${SIZE})`);
