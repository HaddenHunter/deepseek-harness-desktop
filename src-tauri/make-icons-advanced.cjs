// Generate icns (macOS) + ico (Windows) from the existing PNG icons.
// Uses pure Node stdlib + tauri.icon.png (256x256) to avoid deps on sharp/icns libs.
// Outputs:
//   icons/icon.icns   (macOS bundle icon)
//   icons/icon.ico    (Windows bundle icon)
//   icons/icon.png    (256x256 primary PNG)

const { createWriteStream, readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
const { resolve, dirname } = require("node:path");
const { execSync } = require("node:child_process");

const ICONS_DIR = resolve(__dirname, "icons");
mkdirSync(ICONS_DIR, { recursive: true });

const SRC_256 = resolve(ICONS_DIR, "128x128@2x.png"); // 256x256 purple placeholder

if (!existsSync(SRC_256)) {
  console.error("❌ Missing 128x128@2x.png source PNG");
  process.exit(1);
}

// --- PNG helpers: read width/height from 8-byte IHDR after signature ---
function pngDims(buf) {
  // Signature 8 bytes, then 4-byte length, "IHDR" (4 bytes), then 4 bytes width, 4 bytes height
  if (buf.length < 24) throw new Error("png too small");
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return [w, h];
}
const [w, h] = pngDims(readFileSync(SRC_256));
console.log(`src png: ${w}x${h}`);

const pngBuffer256 = readFileSync(SRC_256);
// copy as icon.png (256x256 standard)
writeFileSync(resolve(ICONS_DIR, "icon.png"), pngBuffer256);

// Try to downscale to 32/48/128 for ICO via sips (macOS) or quick Node fallback
function sipsResize(inFile, outFile, size) {
  try {
    execSync(`sips -z ${size} ${size} "${inFile}" --out "${outFile}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngBySize = {};
for (const s of sizes) {
  const out = resolve(ICONS_DIR, `tmp-${s}.png`);
  if (sipsResize(SRC_256, out, s)) {
    pngBySize[s] = readFileSync(out);
    console.log(`✔ resize ${s}x${s} via sips`);
  } else {
    // fallback: for s<=256 that is >= src? just reuse src (sips not available on linux/win)
    pngBySize[s] = readFileSync(SRC_256);
    console.log(`⚠ no sips, reuse 256 for ${s}`);
  }
}

// --- Build .ico file ---
// ICONDIR (6 bytes) + n * ICONDIRENTRY (16 bytes) + raw PNG data
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);        // reserved
  header.writeUInt16LE(1, 2);        // type = ICO
  header.writeUInt16LE(entries.length, 4);
  let off = 6 + 16 * entries.length;
  const entryBufs = entries.map(([sz, data]) => {
    const e = Buffer.alloc(16);
    const dim = sz >= 256 ? 0 : sz; // 0 means 256px (per ICO spec)
    e.writeUInt8(dim, 0);  // w
    e.writeUInt8(dim, 1);  // h
    e.writeUInt8(0, 2);    // pal colors
    e.writeUInt8(0, 3);    // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bit count
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(off, 12);
    off += data.length;
    return e;
  });
  return Buffer.concat([header, ...entryBufs, ...entries.map(([, d]) => d)]);
}

const icoEntries = [
  [16, pngBySize[16]],
  [32, pngBySize[32]],
  [48, pngBySize[48]],
  [64, pngBySize[64]],
  [128, pngBySize[128]],
  [256, pngBySize[256]],
];
writeFileSync(resolve(ICONS_DIR, "icon.ico"), buildIco(icoEntries));
console.log("✅ written icon.ico");

// --- Build .icns file (macOS icon family) ---
// Simple format: 4-byte "icns" + 4-byte total size (big endian) + entries.
// Each entry: 4-byte OSType + 4-byte entry length (incl header) + raw (png or jpeg2000)
// Known types that accept PNG directly (since macOS 10.7 Lion):
//   icp4: 16x16  | icp5: 32x32 | icp6: 64x64
//   ic07: 128x128 | ic08: 256x256 | ic09: 512x512
//   ic10: 512x512@2x (1024x1024)
//   ic11: 32x32@2x (64x64) | ic12: 64x64@2x (128x128) | ic13: 256x256@2x (512x512) | ic14: 512x512@2x (1024x1024)
function icnsEntry(type, data) {
  const len = 8 + data.length;
  const h = Buffer.alloc(8);
  h.write(type, 0, 4, "ascii");
  h.writeUInt32BE(len, 4);
  return Buffer.concat([h, data]);
}

const icnsTypes = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 256], // 512 - missing, reuse 256 (acceptable fallback, macOS auto-scales)
  ["ic10", 256], // 1024 - reuse 256
  ["ic12", 128], // 64@2x 128px
  ["ic13", 256], // 256@2x 512px
  ["ic14", 256], // 512@2x 1024px
];
const icnsChunks = [];
for (const [t, sz] of icnsTypes) {
  const png = pngBySize[sz] ?? pngBySize[256];
  icnsChunks.push(icnsEntry(t, png));
}
const icnsBody = Buffer.concat(icnsChunks);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, 4, "ascii");
icnsHeader.writeUInt32BE(8 + icnsBody.length, 4);
writeFileSync(resolve(ICONS_DIR, "icon.icns"), Buffer.concat([icnsHeader, icnsBody]));
console.log("✅ written icon.icns");

// cleanup tmps
for (const s of sizes) {
  const f = resolve(ICONS_DIR, `tmp-${s}.png`);
  try { require("node:fs").unlinkSync(f); } catch {}
}
console.log("🎨 icon build done.");
