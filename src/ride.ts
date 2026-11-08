// Live guidance during a trip: where you are on the current leg, how many
// stops are left, and a buzz before the stop where you get off. GPS only, so it
// works offline.
import { dist, projectOnLine, sliceLine, type LngLat } from "./geo.ts";
import type { Network } from "./network.ts";
import type { Journey, RideLeg } from "./router.ts";
import { PaceLearner } from "./pace.ts";
import { flush, keep, LegTimer, sharing } from "./triptimes.ts";

export interface RideUpdate {
  status: "ok" | "nogps" | "waiting";
  leg: number; // index into journey.legs; legs.length means arrived
  me?: LngLat;
  acc?: number;
  follow: boolean;
  remaining?: number; // metres left on a walking leg
  stopsLeft?: number; // stops until the one to get off at (1 = next stop)
  nextStop?: number; // stop index
}

const ON_LINE = 60; // metres from the line to count as on the bus
const PASSED = 25; // metres past a stop to count it as passed

export class RideTracker {
  private watch?: number;
  private wake?: WakeLockSentinel;
  private leg = 0;
  private lastAlert = Infinity;
  private pace = new PaceLearner();
  private net: Network;
  private j: Journey;
  private cb: (u: RideUpdate) => void;
  private timers = new Map<number, LegTimer>(); // ride legs' measured times (only when sharing)

  constructor(net: Network, j: Journey, cb: (u: RideUpdate) => void) {
    this.net = net;
    this.j = j;
    this.cb = cb;
  }

  start() {
    this.cb({ status: "waiting", leg: 0, follow: false });
    if (!navigator.geolocation) return this.cb({ status: "nogps", leg: this.leg, follow: false });
    this.watch = navigator.geolocation.watchPosition(
      (p) => this.update([p.coords.longitude, p.coords.latitude], p.coords.accuracy),
      () => this.cb({ status: "nogps", leg: this.leg, follow: false }),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 },
    );
    navigator.wakeLock?.request("screen").then((w) => (this.wake = w), () => {});
  }

  stop() {
    if (this.watch !== undefined) {
      navigator.geolocation.clearWatch(this.watch);
      this.pace.save();
    }
    for (const k of this.timers.keys()) this.endLeg(k); // deleting while iterating a Map is safe
    void flush();
    this.wake?.release().catch(() => {});
    this.watch = undefined;
  }

  /** The timer for ride leg `k`, when the rider shares ride times. */
  private timer(k: number): LegTimer | undefined {
    const leg = this.j.legs[k];
    if (leg?.kind !== "ride" || !sharing()) return undefined;
    let t = this.timers.get(k);
    if (!t) {
      const line = this.net.lines[leg.line];
      const v = line.variants[leg.variant];
      t = new LegTimer(line.ref, String(v.rel), v.stops.map((i) => String(this.net.stops[i].id)), v.along, leg.board, leg.alight);
      this.timers.set(k, t);
    }
    return t;
  }
  private endLeg(k: number) {
    const t = this.timers.get(k);
    if (!t) return;
    keep(t.records());
    this.timers.delete(k);
  }

  /** Where `me` sits along a ride leg, in metres along the line's shape. */
  private along(leg: RideLeg, me: LngLat) {
    const v = this.net.lines[leg.line].variants[leg.variant];
    const from = Math.max(0, v.along[leg.board] - 300);
    const part = sliceLine(v.shape, from, v.along[leg.alight] + 300);
    const pr = projectOnLine(part, me);
    return { along: from + pr.along, offset: pr.offset, v };
  }

  update(me: LngLat, acc: number) {
    const legs = this.j.legs;
    // Move on to the next leg once the current one is clearly done.
    for (let guard = 0; guard < legs.length && this.leg < legs.length; guard++) {
      const leg = legs[this.leg];
      const next = legs[this.leg + 1];
      if (leg.kind === "walk") {
        if (next?.kind === "ride") {
          const a = this.along(next, me);
          const now = Date.now();
          if (dist(me, this.net.stops[a.v.stops[next.board]].ll) < 40) this.timer(this.leg + 1)?.atStop(now);
          if (a.offset < ON_LINE) this.timer(this.leg + 1)?.track(a.along, now, acc, false);
          if (a.offset < ON_LINE && a.along > a.v.along[next.board] + 80) {
            this.leg++;
            continue;
          }
        } else if (dist(me, leg.to) < 25) {
          this.leg++;
          continue;
        }
      } else {
        const a = this.along(leg, me);
        if (a.along > a.v.along[leg.alight] + 60 || (a.offset > 150 && dist(me, this.net.stops[a.v.stops[leg.alight]].ll) < 200)) {
          this.endLeg(this.leg);
          this.leg++;
          continue;
        }
      }
      break;
    }

    const leg = legs[this.leg];
    if (!leg) return this.cb({ status: "ok", leg: this.leg, me, acc, follow: true });
    if (leg.kind === "walk") {
      this.pace.add(me, acc, Date.now());
      return this.cb({ status: "ok", leg: this.leg, me, acc, follow: true, remaining: dist(me, leg.to) });
    }

    const { along, offset, v } = this.along(leg, me);
    // Where the bus is, for the stop-to-stop times (only when sharing).
    const timer = offset < ON_LINE ? this.timer(this.leg) : undefined;
    timer?.track(along, Date.now(), acc);
    let nextIdx = leg.alight;
    for (let i = leg.board; i <= leg.alight; i++)
      if (v.along[i] > along - PASSED) {
        nextIdx = i;
        break;
      }
    const atAlight = Math.abs(v.along[leg.alight] - along) < 40 || dist(me, this.net.stops[v.stops[leg.alight]].ll) < 40;
    const stopsLeft = atAlight ? 0 : Math.max(1, leg.alight - nextIdx + 1);
    // Like Moovit: a light buzz 2 stops out, a stronger one at the last stop, a long one at yours.
    if (stopsLeft < this.lastAlert && stopsLeft <= 2) {
      navigator.vibrate?.(stopsLeft === 0 ? [400, 150, 400, 150, 400] : stopsLeft === 1 ? [250, 120, 250] : [120]);
    }
    this.lastAlert = Math.min(this.lastAlert, stopsLeft);
    this.cb({ status: "ok", leg: this.leg, me, acc, follow: true, stopsLeft, nextStop: v.stops[nextIdx] });
  }
}
