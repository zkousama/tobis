// Walking distances and paths along streets, computed on the phone from a
// compact street graph (see scripts/build-walk.mjs for the file format).
import { dist, type LngLat } from "./geo.ts";
import type { WalkFn } from "./router.ts";
import { DETOUR } from "./router.ts";

export interface WalkGraph {
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  off: Uint32Array; // CSR offsets, n + 1
  to: Uint32Array;
  len: Uint16Array; // decimetres
}

export function parseWalkGraph(buf: ArrayBuffer): WalkGraph {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "WLK1") throw new Error("not a walk graph");
  const n = dv.getUint32(4, true);
  const e = dv.getUint32(8, true);
  let p = 12;
  const coords = new Int32Array(buf, p, n * 2);
  p += n * 8;
  const off = new Uint32Array(buf, p, n + 1);
  p += (n + 1) * 4;
  const to = new Uint32Array(buf, p, e);
  p += e * 4;
  const len = new Uint16Array(buf, p, e);
  // Coordinates are delta-encoded micro-degrees.
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x += coords[2 * i];
    y += coords[2 * i + 1];
    lon[i] = x / 1e6;
    lat[i] = y / 1e6;
  }
  return { n, lon, lat, off, to, len };
}

class Heap {
  k: number[] = [];
  v: number[] = [];
  push(key: number, val: number) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const { k, v } = this;
    const tk = k[0], tv = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return [tk, tv];
  }
  get size() {
    return this.k.length;
  }
}

interface Tree {
  key: string;
  root: LngLat;
  snap: number; // node the root snapped to
  snapM: number;
  d: Map<number, number>; // node -> metres
  prev: Map<number, number>;
}

export class Walker {
  private g: WalkGraph;
  private cell = 0.0015;
  private grid = new Map<number, number[]>();
  private trees: Tree[] = [];
  readonly reach: number;

  constructor(g: WalkGraph, reach = 3000) {
    this.g = g;
    this.reach = reach;
    for (let i = 0; i < g.n; i++) {
      if (g.off[i + 1] === g.off[i]) continue;
      const k = this.cellKey(g.lon[i], g.lat[i]);
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = []));
      c.push(i);
    }
  }
  private cellKey(lon: number, lat: number) {
    return Math.floor(lon / this.cell) * 100000 + Math.floor(lat / this.cell);
  }
  nearest(p: LngLat, maxM = 250): { i: number; d: number } | null {
    const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
    let bestI = -1;
    let bestD = Infinity;
    for (let r = 0; r <= 2; r++) {
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++) {
          if (r && Math.abs(x - cx) < r && Math.abs(y - cy) < r) continue;
          for (const i of this.grid.get(x * 100000 + y) ?? []) {
            const d = dist(p, [this.g.lon[i], this.g.lat[i]]);
            if (d < bestD) {
              bestD = d;
              bestI = i;
            }
          }
        }
      // Anything in a farther ring is at least r cells away.
      if (bestI >= 0 && bestD < this.cell * 96_000 * r) break;
    }
    return bestI >= 0 && bestD <= maxM ? { i: bestI, d: bestD } : null;
  }
  private tree(root: LngLat): Tree | null {
    const key = `${root[0].toFixed(6)},${root[1].toFixed(6)}`;
    const hit = this.trees.find((t) => t.key === key);
    if (hit) return hit;
    const s = this.nearest(root);
    if (!s) return null;
    const d = new Map<number, number>([[s.i, 0]]);
    const prev = new Map<number, number>([[s.i, -1]]);
    const heap = new Heap();
    heap.push(0, s.i);
    const g = this.g;
    while (heap.size) {
      const [c, u] = heap.pop();
      if (c > (d.get(u) ?? Infinity) || c > this.reach) continue;
      for (let e = g.off[u]; e < g.off[u + 1]; e++) {
        const v = g.to[e];
        const nc = c + g.len[e] / 10;
        if (nc < (d.get(v) ?? Infinity)) {
          d.set(v, nc);
          prev.set(v, u);
          heap.push(nc, v);
        }
      }
    }
    const t: Tree = { key, root, snap: s.i, snapM: s.d, d, prev };
    this.trees.unshift(t);
    this.trees.length = Math.min(this.trees.length, 6);
    return t;
  }

  /** Street walking distance and path from a to b, or a straight-line estimate. */
  walk: WalkFn = (a, b) => {
    const crow = dist(a, b);
    if (crow < 60) return { metres: crow };
    // Reuse a search rooted at either end (searches are undirected).
    const keyA = `${a[0].toFixed(6)},${a[1].toFixed(6)}`;
    const keyB = `${b[0].toFixed(6)},${b[1].toFixed(6)}`;
    const haveB = this.trees.some((t) => t.key === keyB);
    const haveA = this.trees.some((t) => t.key === keyA);
    const fromB = haveB && !haveA;
    const tr = this.tree(fromB ? b : a);
    const other = fromB ? a : b;
    const end = tr ? this.nearest(other) : null;
    const d = tr && end ? tr.d.get(end.i) : undefined;
    if (!tr || !end || d === undefined) return { metres: crow * DETOUR };
    const metres = tr.snapM + d + end.d;
    // A path much longer than the straight line means the graph is missing a link.
    if (metres > crow * 3 + 300) return { metres: crow * DETOUR };
    const nodes: number[] = [];
    for (let u = end.i; u !== -1 && u !== undefined; u = tr.prev.get(u)!) nodes.push(u);
    const pts: LngLat[] = nodes.map((i) => [this.g.lon[i], this.g.lat[i]]);
    // pts runs from `other` back to the tree root.
    const path: LngLat[] = fromB ? [a, ...pts, b] : [a, ...pts.reverse(), b];
    return { metres, path };
  };
}

export async function loadWalkGraph(url: string): Promise<WalkFn> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`walk graph: HTTP ${res.status}`);
  const w = new Walker(parseWalkGraph(await res.arrayBuffer()));
  return w.walk;
}
