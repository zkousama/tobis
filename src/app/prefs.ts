import { DEFAULT_VOT, VOT_RANGE, type Prefs } from "../compare.ts";

// How the rider weighs time against money, and whether walking counts double.
// Set in the trip Options panel, used to rank the trips.
export function getPrefs(): Prefs {
  let vot = DEFAULT_VOT;
  let avoidWalk = false;
  try {
    const v = Number(localStorage.getItem("vot"));
    if (v >= VOT_RANGE[0] && v <= VOT_RANGE[1]) vot = v;
    avoidWalk = localStorage.getItem("avoidWalk") === "1";
  } catch {}
  return { vot, walkWeight: avoidWalk ? 3 : 1.5 };
}
export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem("vot", p.vot.toFixed(4));
    localStorage.setItem("avoidWalk", p.walkWeight > 2 ? "1" : "0");
  } catch {}
}
export const toSlider = (vot: number) => Math.round((100 * Math.log(vot / VOT_RANGE[0])) / Math.log(VOT_RANGE[1] / VOT_RANGE[0]));
export const fromSlider = (v: number) => VOT_RANGE[0] * (VOT_RANGE[1] / VOT_RANGE[0]) ** (v / 100);
/** Moved off the middle setting by more than a nudge: counts as a changed option. */
export const prefsChanged = (p: Prefs) => p.walkWeight > 2 || Math.abs(toSlider(p.vot) - toSlider(DEFAULT_VOT)) > 8;
