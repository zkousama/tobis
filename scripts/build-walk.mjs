// Packs the walkable street network into public/data/<city>-walk.bin for
// offline walking directions on the phone.
//
// Format (little-endian): "WLK1", u32 nodes, u32 edges,
// i32[2n] delta-encoded micro-degree lon/lat, u32[n+1] edge offsets,
// u32[e] edge targets, u16[e] edge lengths in decimetres.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { RoadGraph } from "./roadgraph.mjs";

const city = process.argv[2] ?? "agadir";
const g = new RoadGraph(JSON.parse(await readFile(`data/raw/${city}/roads.json`, "utf8")));

// Keep nodes with a walkable edge; collapse chains of degree-2 nodes that are
// almost straight, so the file stays small without bending paths noticeably.
const n0 = g.coord.length;
const walkAdj = Array.from({ length: n0 }, (_, i) => {
  const seen = new Map();
  for (const e of g.adj[i]) if (e.walk && e.to !== i && (!seen.has(e.to) || seen.get(e.to) > e.len)) seen.set(e.to, e.len);
  return seen;
});

const kx = Math.cos((30.4 * Math.PI) / 180) * 111_320, ky = 110_540;
function offLine(a, b, p) {
  const ax = g.coord[a][0] * kx, ay = g.coord[a][1] * ky;
  const bx = g.coord[b][0] * kx - ax, by = g.coord[b][1] * ky - ay;
  const px = g.coord[p][0] * kx - ax, py = g.coord[p][1] * ky - ay;
  const len2 = bx * bx + by * by;
  const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - t * bx, py - t * by);
}
let removed = 0;
for (let i = 0; i < n0; i++) {
  const nb = walkAdj[i];
  if (nb.size !== 2) continue;
  const [[a, la], [b, lb]] = [...nb.entries()];
  if (a === b || walkAdj[a].has(b)) continue;
  if (offLine(a, b, i) > 4) continue;
  // Bypass i with one edge a-b of the combined length.
  walkAdj[a].delete(i);
  walkAdj[b].delete(i);
  walkAdj[a].set(b, la + lb);
  walkAdj[b].set(a, la + lb);
  nb.clear();
  removed++;
}

const keep = [];
const newIndex = new Int32Array(n0).fill(-1);
for (let i = 0; i < n0; i++) {
  if (!walkAdj[i].size) continue;
  newIndex[i] = keep.length;
  keep.push(i);
}
const n = keep.length;
let e = 0;
for (const i of keep) e += walkAdj[i].size;

const buf = Buffer.alloc(12 + n * 8 + (n + 1) * 4 + e * 4 + e * 2);
buf.write("WLK1", 0, "ascii");
buf.writeUInt32LE(n, 4);
buf.writeUInt32LE(e, 8);
let p = 12;
let px = 0, py = 0;
for (const i of keep) {
  const x = Math.round(g.coord[i][0] * 1e6), y = Math.round(g.coord[i][1] * 1e6);
  buf.writeInt32LE(x - px, p);
  buf.writeInt32LE(y - py, p + 4);
  px = x;
  py = y;
  p += 8;
}
const offAt = p;
const toAt = offAt + (n + 1) * 4;
const lenAt = toAt + e * 4;
let k = 0;
keep.forEach((i, ni) => {
  buf.writeUInt32LE(k, offAt + ni * 4);
  for (const [to, len] of walkAdj[i]) {
    buf.writeUInt32LE(newIndex[to], toAt + k * 4);
    buf.writeUInt16LE(Math.min(65535, Math.round(len * 10)), lenAt + k * 2);
    k++;
  }
});
buf.writeUInt32LE(k, offAt + n * 4);

await mkdir("public/data", { recursive: true });
await writeFile(`public/data/${city}-walk.bin`, buf);
console.log(`walk graph: ${n} nodes (${removed} straight-chain nodes folded), ${e} edges, ${(buf.length / 1048576).toFixed(1)} MiB`);
