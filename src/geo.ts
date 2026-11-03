export type LngLat = [number, number];

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function dist(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b, degrees clockwise from north. */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Nearest point on a polyline: distance along it, and how far p is from it. */
export function projectOnLine(line: LngLat[], p: LngLat, fromSeg = 0, toSeg = line.length - 1) {
  let best = { along: 0, offset: Infinity, seg: fromSeg, point: line[fromSeg] ?? p };
  const kx = Math.cos(rad(p[1]));
  let cum = 0;
  for (let i = 0; i < Math.min(toSeg, line.length - 1); i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = dist(a, b);
    if (i >= fromSeg) {
      const ax = (a[0] - p[0]) * kx, ay = a[1] - p[1];
      const dx = (b[0] - a[0]) * kx, dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const q: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const off = dist(q, p);
      if (off < best.offset) best = { along: cum + segLen * t, offset: off, seg: i, point: q };
    }
    cum += segLen;
  }
  return best;
}

/** The part of a polyline between two distances along it. */
export function sliceLine(line: LngLat[], fromM: number, toM: number): LngLat[] {
  const out: LngLat[] = [];
  let cum = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len = dist(a, b);
    const s = cum, e = cum + len;
    if (e >= fromM && s <= toM) {
      const lerp = (m: number): LngLat => {
        const t = len ? (m - s) / len : 0;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      };
      if (!out.length) out.push(fromM > s ? lerp(fromM) : a);
      out.push(toM < e ? lerp(toM) : b);
    }
    cum = e;
    if (cum > toM) break;
  }
  return out;
}

/** Fixed-size grid over lon/lat for quick "what's near here" lookups. */
export class Grid<T> {
  private cells = new Map<string, { p: LngLat; v: T }[]>();
  private readonly step: number;
  constructor(cellMetres = 300) {
    this.step = cellMetres / 111_320;
  }
  private key(x: number, y: number) {
    return `${x}:${y}`;
  }
  add(p: LngLat, v: T) {
    const k = this.key(Math.floor(p[0] / this.step), Math.floor(p[1] / this.step));
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    c.push({ p, v });
  }
  /** Items within `radius` metres of p, nearest first. */
  near(p: LngLat, radius: number): { v: T; d: number }[] {
    const r = Math.ceil(radius / 111_320 / this.step / Math.cos(rad(p[1]))) + 1;
    const cx = Math.floor(p[0] / this.step), cy = Math.floor(p[1] / this.step);
    const out: { v: T; d: number }[] = [];
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (const it of this.cells.get(this.key(x, y)) ?? []) {
          const d = dist(p, it.p);
          if (d <= radius) out.push({ v: it.v, d });
        }
    return out.sort((a, b) => a.d - b.d);
  }
}
