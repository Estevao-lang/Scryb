/**
 * Generates public/icon.ico from public/icon.png
 * Pure Node.js — wraps the PNG bytes inside a valid ICO container.
 * Windows/NSIS accepts ICO files that embed PNG directly (Vista+).
 */
const fs = require("fs");
const path = require("path");

const pngPath = path.join(__dirname, "..", "public", "icon.png");
const icoPath = path.join(__dirname, "..", "public", "icon.ico");

const png = fs.readFileSync(pngPath);
const size = 256;

// ICO header: 6 bytes
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: 1 = ICO
header.writeUInt16LE(1, 4);      // image count: 1

// Directory entry: 16 bytes
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);          // width  (0 = 256)
entry.writeUInt8(0, 1);          // height (0 = 256)
entry.writeUInt8(0, 2);          // color count
entry.writeUInt8(0, 3);          // reserved
entry.writeUInt16LE(1, 4);       // color planes
entry.writeUInt16LE(32, 6);      // bits per pixel
entry.writeUInt32LE(png.length, 8);  // size of image data
entry.writeUInt32LE(6 + 16, 12);    // offset of image data (after header + entry)

const ico = Buffer.concat([header, entry, png]);
fs.writeFileSync(icoPath, ico);
console.log(`[icon] generated ${icoPath}`);
