// Street graph built from OSM highway ways, for tracing bus lines and walking paths.
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function dist(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const NOT_DRIVABLE = new Set(["footway", "path", "steps", "pedestrian", "cycleway", "track"]);
const NOT_WALKABLE = new Set(["motorway", "motorway_link"]);

export class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0], topK = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return [topK, top];
  }
}

export class RoadGraph {
  constructor(roadsJson) {
    this.coord = []; // node index -> [lon,lat]
    this.osmId = [];
    this.index = new Map(); // osm node id -> index
    this.adj = []; // node index -> [{to, len, way, drive, walk}]
    this.ways = new Map(); // way id -> tags
    for (const w of roadsJson.elements) {
      if (w.type !== "way" || !w.geometry) continue;
      const t = w.tags ?? {};
      this.ways.set(w.id, t);
      const hw = t.highway;
      const drive = !NOT_DRIVABLE.has(hw) && t.access !== "no" && t.motor_vehicle !== "no";
      const walk = !NOT_WALKABLE.has(hw) && t.foot !== "no" && t.access !== "private";
      const busBoth = ["no"].includes(t["oneway:bus"]) || ["no"].includes(t["oneway:psv"]) || hw === "busway";
      let oneway = 0;
      if (!busBoth) {
        if (t.oneway === "yes" || t.oneway === "1" || t.junction === "roundabout" || t.junction === "circular" || hw === "motorway") oneway = 1;
        if (t.oneway === "-1") oneway = -1;
        if (t.oneway === "no") oneway = 0;
      }
      const ids = w.nodes;
      for (let i = 0; i < ids.length; i++) {
        if (!w.geometry[i]) continue;
        this.node(ids[i], [w.geometry[i].lon, w.geometry[i].lat]);
      }
      for (let i = 0; i < ids.length - 1; i++) {
        const a = this.index.get(ids[i]), b = this.index.get(ids[i + 1]);
        if (a === undefined || b === undefined) continue;
        const len = dist(this.coord[a], this.coord[b]);
        this.adj[a].push({ to: b, len, way: w.id, drive: drive && oneway !== -1, walk });
        this.adj[b].push({ to: a, len, way: w.id, drive: drive && oneway !== 1, walk });
      }
    }
    // Grid for nearest-node lookups.
    this.cell = 0.002;
    this.grid = new Map();
    this.coord.forEach((c, i) => {
      const k = `${Math.floor(c[0] / this.cell)}:${Math.floor(c[1] / this.cell)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(i);
    });
  }
  node(id, ll) {
    if (this.index.has(id)) return this.index.get(id);
    const i = this.coord.length;
    this.coord.push(ll);
    this.osmId.push(id);
    this.adj.push([]);
    this.index.set(id, i);
    return i;
  }
  /** Graph nodes within `radius` metres of p that have an edge of the given mode. */
  near(p, radius, mode) {
    const r = Math.ceil(radius / 111_000 / this.cell) + 1;
    const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
    const out = [];
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (const i of this.grid.get(`${x}:${y}`) ?? []) {
          const d = dist(p, this.coord[i]);
          if (d <= radius && this.adj[i].some((e) => e[mode])) out.push({ i, d });
        }
    return out.sort((a, b) => a.d - b.d);
  }
  /**
   * Cheapest path from any of `starts` to any of `goals` ({i, cost} seeds).
   * `weight(edge)` scales an edge's length. Returns {nodes, metres} or null.
   */
  path(starts, goals, mode, weight = () => 1, maxCost = Infinity) {
    const goalCost = new Map(goals.map((g) => [g.i, g.cost ?? 0]));
    const best = new Map();
    const prev = new Map();
    const heap = new MinHeap();
    for (const s of starts) {
      const c = s.cost ?? 0;
      if (!best.has(s.i) || c < best.get(s.i)) (best.set(s.i, c), prev.set(s.i, -1), heap.push(c, s.i));
    }
    let found = -1, foundCost = Infinity;
    while (heap.size) {
      const [c, u] = heap.pop();
      if (c > best.get(u)) continue;
      if (c >= foundCost || c > maxCost) break;
      if (goalCost.has(u) && c + goalCost.get(u) < foundCost) (found = u, foundCost = c + goalCost.get(u));
      for (const e of this.adj[u]) {
        if (!e[mode]) continue;
        const nc = c + e.len * weight(e);
        if (nc < (best.get(e.to) ?? Infinity)) (best.set(e.to, nc), prev.set(e.to, u), heap.push(nc, e.to));
      }
    }
    if (found < 0) return null;
    const nodes = [];
    for (let u = found; u !== -1; u = prev.get(u)) nodes.push(u);
    nodes.reverse();
    let metres = 0;
    for (let i = 1; i < nodes.length; i++) metres += dist(this.coord[nodes[i - 1]], this.coord[nodes[i]]);
    return { nodes, metres };
  }
}
