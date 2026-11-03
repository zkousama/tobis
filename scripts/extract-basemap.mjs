// Cuts a city's area out of a Protomaps world build into one PMTiles v3 file.
// Usage: node scripts/extract-basemap.mjs agadir [maxzoom] [build-date]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { PMTiles, zxyToTileId } from "pmtiles";

const city = process.argv[2] ?? "agadir";
const maxZoom = Number(process.argv[3] ?? 14);
const cfg = JSON.parse(await readFile(`cities/${city}.json`, "utf8"));

async function latestBuild() {
  const res = await fetch("https://build-metadata.protomaps.dev/builds.json");
  const builds = await res.json();
  return builds.map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort().at(-1);
}
const build = process.argv[4] ? `${process.argv[4]}.pmtiles` : await latestBuild();
const source = new PMTiles(`https://build.protomaps.com/${build}`);
const srcHeader = await source.getHeader();
console.log(`source ${build}, zoom 0-${maxZoom}`);

const [w, s, e, n] = cfg.bbox;
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

const wanted = [];
for (let z = 0; z <= maxZoom; z++) {
  for (let x = lon2x(w, z); x <= lon2x(e, z); x++)
    for (let y = lat2y(n, z); y <= lat2y(s, z); y++) wanted.push([z, x, y]);
}
console.log(`${wanted.length} tiles to fetch`);

const tiles = new Map(); // tileId -> Buffer (gzipped)
let done = 0;
async function worker() {
  while (wanted.length) {
    const [z, x, y] = wanted.pop();
    for (let attempt = 0; ; attempt++) {
      try {
        const t = await source.getZxy(z, x, y);
        if (t?.data) tiles.set(zxyToTileId(z, x, y), gzipSync(Buffer.from(t.data), { level: 9 }));
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    if (++done % 200 === 0) console.log(`  ${done}`);
  }
}
await Promise.all(Array.from({ length: 12 }, worker));

// Tile data section, deduplicated, in tile-id order (clustered).
const ids = [...tiles.keys()].sort((a, b) => a - b);
const seen = new Map(); // hash -> {offset,length}
const chunks = [];
let dataLen = 0;
const entries = [];
for (const id of ids) {
  const buf = tiles.get(id);
  const h = createHash("sha256").update(buf).digest("hex");
  let loc = seen.get(h);
  if (!loc) {
    loc = { offset: dataLen, length: buf.length };
    seen.set(h, loc);
    chunks.push(buf);
    dataLen += buf.length;
  }
  const last = entries.at(-1);
  if (last && last.tileId + last.runLength === id && last.offset === loc.offset) last.runLength++;
  else entries.push({ tileId: id, runLength: 1, offset: loc.offset, length: loc.length });
}

function varints(nums) {
  const out = [];
  for (let v of nums) {
    while (v >= 0x80) {
      out.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    out.push(v);
  }
  return out;
}
function serializeDir(es) {
  const nums = [es.length];
  let prev = 0;
  for (const e of es) {
    nums.push(e.tileId - prev);
    prev = e.tileId;
  }
  for (const e of es) nums.push(e.runLength);
  for (const e of es) nums.push(e.length);
  es.forEach((e, i) => {
    const prevE = es[i - 1];
    nums.push(i > 0 && e.offset === prevE.offset + prevE.length ? 0 : e.offset + 1);
  });
  return gzipSync(Buffer.from(varints(nums)), { level: 9 });
}

// Root directory, with leaf directories if it doesn't fit in the first 16 KiB.
let root = serializeDir(entries);
let leaves = Buffer.alloc(0);
for (let leafSize = 4096; 127 + root.length > 16384; leafSize *= 2) {
  const rootEntries = [];
  const leafBufs = [];
  let off = 0;
  for (let i = 0; i < entries.length; i += leafSize) {
    const leaf = serializeDir(entries.slice(i, i + leafSize));
    rootEntries.push({ tileId: entries[i].tileId, runLength: 0, offset: off, length: leaf.length });
    leafBufs.push(leaf);
    off += leaf.length;
  }
  root = serializeDir(rootEntries);
  leaves = Buffer.concat(leafBufs);
}

const metadata = gzipSync(
  Buffer.from(
    JSON.stringify({
      ...(await source.getMetadata()),
      description: `Protomaps basemap ${build}, cut to ${cfg.id} bbox ${cfg.bbox.join(",")}`,
      attribution: "© OpenStreetMap contributors",
    }),
  ),
);

const H = Buffer.alloc(127);
H.write("PMTiles", 0, "ascii");
H.writeUInt8(3, 7);
const rootOff = 127;
const metaOff = rootOff + root.length;
const leafOff = metaOff + metadata.length;
const dataOff = leafOff + leaves.length;
const u64 = (v, at) => H.writeBigUInt64LE(BigInt(v), at);
u64(rootOff, 8); u64(root.length, 16);
u64(metaOff, 24); u64(metadata.length, 32);
u64(leafOff, 40); u64(leaves.length, 48);
u64(dataOff, 56); u64(dataLen, 64);
u64(ids.length, 72); u64(entries.length, 80); u64(seen.size, 88);
H.writeUInt8(1, 96); // clustered
H.writeUInt8(2, 97); // internal compression: gzip
H.writeUInt8(2, 98); // tile compression: gzip
H.writeUInt8(srcHeader.tileType, 99);
H.writeUInt8(0, 100);
H.writeUInt8(maxZoom, 101);
const e7 = (v) => Math.round(v * 1e7);
H.writeInt32LE(e7(w), 102); H.writeInt32LE(e7(s), 106);
H.writeInt32LE(e7(e), 110); H.writeInt32LE(e7(n), 114);
H.writeUInt8(cfg.zoom, 118);
H.writeInt32LE(e7(cfg.center[0]), 119); H.writeInt32LE(e7(cfg.center[1]), 123);

await mkdir("public/basemap", { recursive: true });
const out = Buffer.concat([H, root, metadata, leaves, ...chunks]);
await writeFile(`public/basemap/${cfg.id}.pmtiles`, out);
console.log(`wrote public/basemap/${cfg.id}.pmtiles: ${(out.length / 1048576).toFixed(1)} MiB, ${ids.length} tiles, ${seen.size} unique`);
