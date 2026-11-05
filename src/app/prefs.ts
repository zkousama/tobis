import { DEFAULT_VOT, VOT_RANGE, type Prefs } from "../compare.ts";

// How the rider weighs time against money, and whether walking counts double.
// Set in the trip Options panel, used to rank the trips.
/** Route preference, as maps apps offer it: best overall, fewer changes, or less walking. */
export type RoutePref = "best" | "changes" | "walk";
export function getPrefs(): Prefs {
  let vot = DEFAULT_VOT;
  let route: RoutePref = "best";
  try {
    const v = Number(localStorage.getItem("vot"));
    if (v >= VOT_RANGE[0] && v <= VOT_RANGE[1]) vot = v;
    const r = localStorage.getItem("route");
    // "avoidWalk" is the older switch; it meant less walking.
    route = r === "changes" || r === "walk" ? r : localStorage.getItem("avoidWalk") === "1" ? "walk" : "best";
  } catch {}
  return { vot, walkWeight: route === "walk" ? 3 : 1.5, changeMinutes: route === "changes" ? 20 : 5 };
}
export const routeOf = (p: Prefs): RoutePref => (p.walkWeight > 2 ? "walk" : (p.changeMinutes ?? 5) > 10 ? "changes" : "best");
export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem("vot", p.vot.toFixed(4));
    localStorage.setItem("route", routeOf(p));
    localStorage.removeItem("avoidWalk");
  } catch {}
}
export const routePrefs = (r: RoutePref) => ({ walkWeight: r === "walk" ? 3 : 1.5, changeMinutes: r === "changes" ? 20 : 5 });
/** A route preference other than "best" counts as a changed option. (The value of time is no longer
 * set by hand: bus fares in Agadir differ by a dirham or so; it only drifts a little with the trips picked.) */
export const prefsChanged = (p: Prefs) => routeOf(p) !== "best";
