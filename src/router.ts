// Trip planner for a bus network without timetables.
//
// Works in rounds like RAPTOR: round k holds the cheapest way to reach every
// stop using k buses. Costs are seconds: walking, an estimated wait at each
// boarding, and riding time estimated from distance along the line.
import { dist, Grid, type LngLat } from "./geo.ts";
import type { Network } from "./network.ts";

export const WALK_SPEED = 1.25; // m/s, about 4.5 km/h
export const DETOUR = 1.3; // street distance / straight-line distance, when no street path is known
export const MAX_ACCESS = 1200; // metres walked to the first stop or from the last one
export const MAX_TRANSFER = 400; // metres walked between two buses
// Expected wait per boarding when no frequency is published, seconds.
// A grand taxi leaves its stand when full: about 10 minutes.
export const WAIT = { bus: 600, brt: 300, taxi: 600 };
/** Expected wait: half the gap between buses when it's published, else a default. */
export const waitFor = (line: { brt: boolean; headway?: number; taxi?: boolean }) => (line.headway ? (line.headway * 60) / 2 : line.brt ? WAIT.brt : line.taxi ? WAIT.taxi : WAIT.bus);
export const TRANSFER_PENALTY = 180; // extra seconds per change, so direct trips win ties
export const DWELL = 20; // seconds lost at each intermediate stop

/**
 * Seconds to ride one stop-to-stop section: buses crawl where stops are close
 * together and speed up on long open stretches. Includes the stop itself.
 */
export function sectionSeconds(metres: number): number {
  const speed = Math.min(14, 4.5 + metres / 220); // m/s: ~23 km/h at 400 m spacing, 50 km/h on long rural runs
  return metres / speed + DWELL;
}
/** Cumulative riding seconds at each stop of a direction. */
export function rideClock(along: number[]): Float64Array {
  const t = new Float64Array(along.length);
  for (let i = 1; i < along.length; i++) t[i] = t[i - 1] + sectionSeconds(Math.max(0, along[i] - along[i - 1]));
  return t;
}

export type WalkFn = (a: LngLat, b: LngLat) => { metres: number; path?: LngLat[] };
export const crowWalk: WalkFn = (a, b) => ({ metres: dist(a, b) * DETOUR });

export interface WalkLeg {
  kind: "walk";
  from: LngLat;
  to: LngLat;
  metres: number;
  seconds: number;
  path?: LngLat[];
}
export interface RideLeg {
  kind: "ride";
  line: number; // index into network.lines
  variant: number; // index into line.variants
  board: number; // index into variant.stops
  alight: number;
  metres: number;
  seconds: number; // riding only
  wait: number;
}
export type Leg = WalkLeg | RideLeg;
export interface Journey {
  legs: Leg[];
  seconds: number;
  walkMetres: number;
  rides: number;
}

interface Label {
  cost: number;
  // how we got here
  via:
    | { kind: "origin"; metres: number }
    | { kind: "ride"; line: number; variant: number; board: number; alight: number; prevStop: number }
    | { kind: "transfer"; fromStop: number; metres: number };
}

export class Router {
  readonly net: Network;
  private grid = new Grid<number>(300);
  private walk: WalkFn;
  // For each stop: the stops within MAX_TRANSFER, with walking metres.
  private transfers: { to: number; metres: number }[][];
  private flat: { line: number; variant: number; brt: boolean; wait: number; clock: Float64Array }[] = [];
  private clocks = new Map<string, Float64Array>();

  constructor(net: Network, walk: WalkFn = crowWalk) {
    this.net = net;
    this.walk = walk;
    net.stops.forEach((s, i) => this.grid.add(s.ll, i));
    this.transfers = net.stops.map((s, i) =>
      this.grid
        .near(s.ll, MAX_TRANSFER / DETOUR)
        .filter((x) => x.v !== i)
        .map((x) => ({ to: x.v, metres: x.d * DETOUR })),
    );
    net.lines.forEach((l, li) =>
      l.variants.forEach((v, vi) => {
        if (v.stops.length < 2) return;
        const clock = rideClock(v.along);
        this.clocks.set(`${li}:${vi}`, clock);
        this.flat.push({ line: li, variant: vi, brt: l.brt, wait: waitFor(l), clock });
      }),
    );
  }

  private walkSpeed = WALK_SPEED;
  /** The rider's own walking pace, learned in ride mode (m/s). */
  setWalkSpeed(v: number) {
    this.walkSpeed = v;
  }

  /** Swap in street walking once its graph has loaded. */
  setWalk(walk: WalkFn) {
    this.walk = walk;
  }

  stopsNear(p: LngLat, radius = MAX_ACCESS) {
    return this.grid.near(p, radius / DETOUR).map((x) => ({ stop: x.v, crow: x.d }));
  }

  plan(origin: LngLat, dest: LngLat, opts: { maxRides?: number; limit?: number } = {}): Journey[] {
    const maxRides = opts.maxRides ?? 3;
    const n = this.net.stops.length;
    // rides[k][s]: reached s by getting off the k-th bus. reach[k][s]: rides[k], or a short walk on from one.
    const rides: (Label | undefined)[][] = [];
    const reach: (Label | undefined)[][] = [];

    // Round 0: walk from the origin.
    const r0: (Label | undefined)[] = Array.from({ length: n });
    for (const { stop } of this.stopsNear(origin)) {
      const metres = this.walk(origin, this.net.stops[stop].ll).metres;
      if (metres > MAX_ACCESS) continue;
      r0[stop] = { cost: metres / this.walkSpeed, via: { kind: "origin", metres } };
    }
    rides.push(r0);
    reach.push(r0);

    const egress = this.stopsNear(dest)
      // Walking is symmetric; rooting at dest lets the street search be reused for every stop.
      .map(({ stop }) => ({ stop, metres: this.walk(dest, this.net.stops[stop].ll).metres }))
      .filter((e) => e.metres <= MAX_ACCESS);

    const candidates: { round: number; stop: number; cost: number; egressMetres: number }[] = [];

    for (let k = 1; k <= maxRides; k++) {
      const prev = reach[k - 1];
      const cur: (Label | undefined)[] = Array.from({ length: n });
      // Ride every direction of every line once.
      for (const f of this.flat) {
        const v = this.net.lines[f.line].variants[f.variant];
        const wait = f.wait;
        let boardAt = -1;
        let boardCost = Infinity;
        const breaks = v.breaks;
        for (let j = 0; j < v.stops.length; j++) {
          const s = v.stops[j];
          // Never ride through a section whose stop order is in doubt.
          if (breaks && breaks.includes(j - 1)) {
            boardAt = -1;
            boardCost = Infinity;
          }
          if (boardAt >= 0) {
            const metres = v.along[j] - v.along[boardAt];
            if (metres > 0) {
              const cost = boardCost + f.clock[j] - f.clock[boardAt] - DWELL;
              if (!cur[s] || cost < cur[s]!.cost)
                cur[s] = { cost, via: { kind: "ride", line: f.line, variant: f.variant, board: boardAt, alight: j, prevStop: v.stops[boardAt] } };
            }
          }
          const here = prev[s];
          if (here && j < v.stops.length - 1) {
            const c = here.cost + wait + (k > 1 ? TRANSFER_PENALTY : 0);
            // Board here if it beats staying on from an earlier stop.
            const stayCost = boardAt >= 0 ? boardCost + f.clock[j] - f.clock[boardAt] - DWELL : Infinity;
            if (c < stayCost) {
              boardAt = j;
              boardCost = c;
            }
          }
        }
      }
      // Then allow one short walk to a nearby stop before the next bus.
      const walked: (Label | undefined)[] = cur.slice();
      cur.forEach((lab, s) => {
        if (!lab) return;
        for (const t of this.transfers[s]) {
          const cost = lab.cost + t.metres / this.walkSpeed;
          if (!walked[t.to] || cost < walked[t.to]!.cost)
            walked[t.to] = { cost, via: { kind: "transfer", fromStop: s, metres: t.metres } };
        }
      });
      rides.push(cur);
      reach.push(walked);
      for (const e of egress) {
        const lab = cur[e.stop]; // only a bus arrival can end the trip here
        if (lab) candidates.push({ round: k, stop: e.stop, cost: lab.cost + e.metres / this.walkSpeed, egressMetres: e.metres });
      }
    }

    const journeys = candidates.map((c) => this.build(rides, reach, c.round, c.stop, origin, dest, c.egressMetres));

    // Walking all the way is an option too when it's short.
    const direct = this.walk(origin, dest);
    if (direct.metres <= 2500)
      journeys.push({
        legs: [{ kind: "walk", from: origin, to: dest, metres: direct.metres, seconds: direct.metres / this.walkSpeed, path: direct.path }],
        seconds: direct.metres / this.walkSpeed,
        walkMetres: direct.metres,
        rides: 0,
      });

    return pickDiverse(journeys, this.net, opts.limit ?? 5);
  }

  private build(rides: (Label | undefined)[][], reach: (Label | undefined)[][], round: number, stop: number, origin: LngLat, dest: LngLat, egressMetres: number): Journey {
    const legs: Leg[] = [];
    const ll = (s: number) => this.net.stops[s].ll;
    legs.push(this.walkLeg(ll(stop), dest, egressMetres));
    let lab = rides[round][stop];
    let k = round;
    let s = stop;
    while (lab) {
      const via = lab.via;
      if (via.kind === "origin") {
        legs.push(this.walkLeg(origin, ll(s), via.metres));
        break;
      }
      if (via.kind === "transfer") {
        legs.push(this.walkLeg(ll(via.fromStop), ll(s), via.metres));
        s = via.fromStop;
        lab = rides[k][s];
        continue;
      }
      const v = this.net.lines[via.line].variants[via.variant];
      const metres = v.along[via.alight] - v.along[via.board];
      legs.push({
        kind: "ride",
        line: via.line,
        variant: via.variant,
        board: via.board,
        alight: via.alight,
        metres,
        seconds: this.rideSeconds(via.line, via.variant, via.board, via.alight),
        wait: waitFor(this.net.lines[via.line]),
      });
      s = via.prevStop;
      k -= 1;
      lab = reach[k][s];
    }
    if (!lab) throw new Error("broken journey");
    legs.reverse();
    const clean = legs.filter((l) => l.kind === "ride" || l.metres > 1);
    let seconds = 0;
    let walkMetres = 0;
    for (const l of clean) {
      seconds += l.seconds + (l.kind === "ride" ? l.wait : 0);
      if (l.kind === "walk") walkMetres += l.metres;
    }
    return { legs: clean, seconds, walkMetres, rides: clean.filter((l) => l.kind === "ride").length };
  }

  rideSeconds(line: number, variant: number, board: number, alight: number) {
    const c = this.clocks.get(`${line}:${variant}`);
    return c ? c[alight] - c[board] - DWELL : 0;
  }

  private walkLeg(from: LngLat, to: LngLat, metres: number): WalkLeg {
    const w = this.walk(from, to);
    const m = w.path ? w.metres : metres;
    return { kind: "walk", from, to, metres: m, seconds: m / this.walkSpeed, path: w.path };
  }
}

/** Best few journeys, each using a different sequence of lines, dropping clearly worse ones. */
export function pickDiverse(js: Journey[], net: Network, limit: number): Journey[] {
  const key = (j: Journey) => j.legs.filter((l): l is RideLeg => l.kind === "ride").map((l) => net.lines[l.line].ref).join(">") || "walk";
  const best = new Map<string, Journey>();
  for (const j of js) {
    const k = key(j);
    const b = best.get(k);
    if (!b || j.seconds < b.seconds) best.set(k, j);
  }
  const sorted = [...best.values()].sort((a, b) => a.seconds - b.seconds);
  const out: Journey[] = [];
  for (const j of sorted) {
    // Skip a trip that's slower than one we kept and needs at least as many buses.
    const dominated = out.some((o) => o.rides <= j.rides && o.seconds <= j.seconds - 60 && j.rides > 0 && (o.rides < j.rides || j.seconds > o.seconds * 1.5));
    if (dominated) continue;
    out.push(j);
    if (out.length >= limit) break;
  }
  return out;
}
