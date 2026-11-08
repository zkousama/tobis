// Ride times, shared only when the rider turns it on (Settings): how long a bus took from one stop to
// the next, and how long the rider waited before it came. Nothing else: no position, no account, no
// device id. Records wait on this phone and go out when there's a connection.

export interface Hop {
  k: "hop";
  l: string; // line ref
  v: string; // direction (the variant's id)
  a: string; // stop id
  b: string; // next stop id
  s: number; // seconds
  d: string; // day, YYYY-MM-DD
  h: number; // hour, 0-23
  w: number; // weekday, 0 = Sunday
}
export interface Wait {
  k: "wait";
  l: string;
  v: string;
  a: string; // the stop
  s: number;
  d: string;
  h: number;
  w: number;
}
export type TimeRecord = Hop | Wait;

const KEY = "tripTimes";
const ON = "shareTimes";
const MAX_QUEUE = 500;
const ENDPOINT = "/api/times";

export function sharing(): boolean {
  try {
    return localStorage.getItem(ON) === "1";
  } catch {
    return false;
  }
}
export function setSharing(on: boolean) {
  try {
    if (on) localStorage.setItem(ON, "1");
    else {
      localStorage.removeItem(ON);
      localStorage.removeItem(KEY); // turned off: what wasn't sent yet is dropped
    }
  } catch {}
}

const stamp = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return { d: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, h: d.getHours(), w: d.getDay() };
};

function queue(): TimeRecord[] {
  try {
    const q = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function save(q: TimeRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q.slice(-MAX_QUEUE)));
  } catch {}
}

/**
 * Watches one ride leg: the moments the bus passes each stop, and when the rider reached the stop to
 * board. Plausible stop-to-stop times become hops; the wait becomes a wait. Kept only while sharing.
 */
export class LegTimer {
  private passed = new Map<number, { t: number; acc: number }>(); // stop index → when the bus passed it
  private reachedStop?: number; // when the rider got to the boarding stop
  private l: string;
  private v: string;
  private stops: string[];
  private along: number[];
  private board: number;
  private alight: number;

  constructor(l: string, v: string, stops: string[], along: number[], board: number, alight: number) {
    this.l = l;
    this.v = v;
    this.stops = stops;
    this.along = along;
    this.board = board;
    this.alight = alight;
  }

  /** The rider is at the boarding stop, waiting. */
  atStop(t: number) {
    this.reachedStop ??= t;
  }

  private prev?: { along: number; t: number; acc: number };
  private lastAtStop?: { t: number; acc: number }; // the last fix still at the boarding stop

  /**
   * A GPS fix on the line: `along` metres along it at time `t` (accuracy `acc`, metres). A stop counts
   * as passed at a known moment only when two fixes no more than 15 s apart fall on either side of it;
   * the moment is placed between them. A stop passed before ride mode started, or during a GPS gap,
   * gets no time.
   */
  track(along: number, t: number, acc: number, onBoard = true) {
    // Before boarding, a rider walking along the street isn't the bus: only fixes from the stop on count.
    if (!onBoard && this.reachedStop === undefined) return;
    const p = this.prev;
    this.prev = { along, t, acc };
    // Leaving the boarding stop: GPS drift while waiting can cross it, so the bus has left only once
    // the rider is 80 m down the line; it left at the last fix still at the stop.
    const at = this.along[this.board];
    if (!this.passed.has(this.board)) {
      if (along <= at + 10) this.lastAtStop = { t, acc };
      else if (along > at + 80 && this.lastAtStop && t - this.lastAtStop.t <= 30_000 && this.lastAtStop.acc <= 50) this.passed.set(this.board, this.lastAtStop);
    }
    if (!p || t - p.t > 15_000 || along <= p.along || Math.max(acc, p.acc) > 50) return;
    for (let i = this.board + 1; i <= this.alight; i++) {
      const x = this.along[i];
      if (x <= p.along || x > along || this.passed.has(i)) continue;
      this.passed.set(i, { t: p.t + ((x - p.along) / (along - p.along)) * (t - p.t), acc: Math.max(acc, p.acc) });
    }
  }

  /** What this leg measured; called when the leg ends. */
  records(): TimeRecord[] {
    const out: TimeRecord[] = [];
    const left = this.passed.get(this.board);
    if (left && this.reachedStop !== undefined) {
      const s = Math.round((left.t - this.reachedStop) / 1000);
      if (s >= 0 && s <= 3600) out.push({ k: "wait", l: this.l, v: this.v, a: this.stops[this.board], s, ...stamp(this.reachedStop) });
    }
    for (const [i, p] of this.passed) {
      const q = this.passed.get(i + 1);
      if (!q || i + 1 > this.alight) continue;
      const s = Math.round((q.t - p.t) / 1000);
      const metres = this.along[i + 1] - this.along[i];
      // Faster than 80 km/h, or slower than walking: GPS trouble or not the bus.
      if (s < 5 || s > 1800 || metres / s > 22 || metres / s < 1.5) continue;
      out.push({ k: "hop", l: this.l, v: this.v, a: this.stops[i], b: this.stops[i + 1], s, ...stamp(p.t) });
    }
    return out;
  }
}

/** Adds a leg's records to the queue, if the rider shares. */
export function keep(records: TimeRecord[]) {
  if (!sharing() || !records.length) return;
  save([...queue(), ...records]);
}

/** Sends what's queued; keeps it for later when offline or when the server says no. */
export async function flush(): Promise<number> {
  if (!sharing() || !navigator.onLine) return 0;
  const q = queue();
  if (!q.length) return 0;
  const batch = q.slice(0, 200);
  try {
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, items: batch }) });
    if (!res.ok) return 0;
    save(queue().slice(batch.length));
    return batch.length;
  } catch {
    return 0;
  }
}
