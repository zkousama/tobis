// Your own walking pace, learned from ride mode and kept on this phone only.
// Only stretches that look like walking count: a decent GPS fix, at least 30 s
// and 25 m, at 0.6-2.2 m/s. Each trip nudges the stored pace a little, so one
// odd walk can't throw it off.
import { dist, type LngLat } from "./geo.ts";

export const DEFAULT_PACE = 1.25; // m/s, about 4.5 km/h
const KEY = "walkPace";

export function walkPace(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (v >= 0.8 && v <= 2) return v;
  } catch {}
  return DEFAULT_PACE;
}

export class PaceLearner {
  private last?: { ll: LngLat; at: number };
  private samples: number[] = [];

  /** Feed a GPS fix taken while the rider is on a walking leg. */
  add(ll: LngLat, acc: number, at: number) {
    if (acc > 25) return;
    if (!this.last) {
      this.last = { ll, at };
      return;
    }
    const dt = (at - this.last.at) / 1000;
    if (dt < 30) return;
    const d = dist(this.last.ll, ll);
    this.last = { ll, at };
    const v = d / dt;
    if (d >= 25 && v >= 0.6 && v <= 2.2) this.samples.push(v);
  }

  /** The pace this trip suggests (median of samples), if there's enough to go on. */
  estimate(): number | undefined {
    if (this.samples.length < 3) return undefined;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /** Blend this trip into the stored pace. Returns the new pace. */
  save(): number {
    const e = this.estimate();
    const old = walkPace();
    if (e === undefined) return old;
    const next = Math.min(1.9, Math.max(0.85, old * 0.7 + e * 0.3));
    try {
      localStorage.setItem(KEY, next.toFixed(3));
    } catch {}
    return next;
  }
}
