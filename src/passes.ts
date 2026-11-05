// When a line passes a stop, for lines that publish a first departure and a frequency
// (the Trambus). There are no timetables, so these are estimates: the first departure
// from the end of the line, plus the riding time to the stop, then every `headway` minutes.
import { rideClock } from "./router.ts";
import type { Line } from "./network.ts";

const minutes = (hhmm?: string) => {
  const m = hhmm && /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/** The next `count` estimated passages at stop index `at` of variant `vi`, from `now`; [] when the line publishes no times. */
export function nextPasses(line: Line, vi: number, at: number, now: Date, count = 3): Date[] {
  const first = minutes(line.hours?.first);
  if (first === undefined || !line.headway) return [];
  const last = minutes(line.hours?.last);
  const v = line.variants[vi];
  const offset = rideClock(v.along)[at] / 60; // minutes from the end of the line to this stop
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nowMin = (now.getTime() - day.getTime()) / 60000;
  const out: Date[] = [];
  for (let d = 0; d < 2 && out.length < count; d++) {
    // Departures from the end of the line, every headway, from the first (until the last, when known).
    let k = Math.max(0, Math.ceil((nowMin - d * 1440 - offset - first) / line.headway));
    for (; out.length < count; k++) {
      const dep = first + k * line.headway;
      if (last !== undefined && dep > last) break;
      if (dep >= 24 * 60) break;
      out.push(new Date(day.getTime() + (d * 1440 + dep + offset) * 60000));
    }
  }
  return out;
}
