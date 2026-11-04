// Every way to make a trip, in one comparable shape: time split into walking,
// waiting and riding, a price (or range), and how much walking it takes.
import { dist, inPolygon, type LngLat } from "./geo.ts";
import type { Network } from "./network.ts";
import type { Journey, RideLeg } from "./router.ts";
import { fareFor } from "./fares.ts";
import { visible } from "./ui/colour.ts";

// Taxis ride in dark grey, so they can't be mistaken for a bus line's colour.
const TAXI = "#3c444c";

export type Priority = "fast" | "cheap" | "walk";
export interface Part {
  k: "walk" | "wait" | "ride";
  s: number; // seconds
  colour?: string; // the line's colour, for riding
}
export interface Option {
  kind: "transit" | "walk" | "petitTaxi" | "airportTaxi";
  journey?: number; // index into the planned journeys
  seconds: number; // likely total
  range: [number, number]; // quick and slow ends: unknown waits, traffic
  nightRate?: boolean;
  cost?: { low: number; high: number }; // DH; undefined when nobody publishes it
  walkMetres: number;
  parts: Part[];
  perCar?: boolean;
}
export interface TaxiNote {
  kind: "otherTown";
  town: string;
}

const normalizeName = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** The commune a point is in, by the OSM outlines; falls back to the nearest town centre. */
export function townOf(net: Network, ll: LngLat): string | undefined {
  const c = net.communes?.find((x) => inPolygon(ll, x.rings));
  if (c) return c.n.d;
  let best: { name: string; d: number } | undefined;
  for (const p of net.places) {
    if (p.k !== "town" || (p.t !== "city" && p.t !== "town")) continue;
    const d = dist(ll, p.ll);
    if (d < 8000 && (!best || d < best.d)) best = { name: p.n.d ?? "", d };
  }
  return best?.name;
}

/** Late evening and early morning, when buses are rare and the Trambus hasn't started. */
export const isNight = (d: Date) => d.getHours() >= 22 || d.getHours() < 6;

export function buildOptions(net: Network, journeys: Journey[], from: LngLat, to: LngLat, now = new Date(), pace = 1.25): { options: Option[]; note?: TaxiNote; night: boolean } {
  const options: Option[] = [];
  journeys.forEach((j, i) => {
    const parts: Part[] = [];
    let low = 0;
    let known = true;
    // Range: no wait at all at the quick end; at the slow end, a full gap between
    // buses (twice the expected wait when nobody publishes it) and slow traffic.
    let quick = 0;
    let slow = 0;
    for (const l of j.legs) {
      if (l.kind === "walk") {
        const s = l.metres / pace;
        parts.push({ k: "walk", s });
        quick += s * 0.9;
        slow += s * 1.1;
        continue;
      }
      const line = net.lines[l.line];
      parts.push({ k: "wait", s: l.wait }, { k: "ride", s: l.seconds, colour: visible(line.colour) });
      quick += l.seconds * 0.9;
      slow += (line.headway ? line.headway * 60 : l.wait * 2) + l.seconds * (line.brt ? 1.1 : 1.35);
      const f = fareFor(line, line.variants[l.variant], l.board, l.alight);
      if (f) low += f.normal;
      else known = false;
    }
    const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride").length;
    const seconds = parts.reduce((n, p) => n + p.s, 0);
    options.push({
      kind: rides ? "transit" : "walk",
      journey: i,
      seconds,
      range: [Math.min(quick, seconds), Math.max(slow, seconds)],
      cost: !rides ? { low: 0, high: 0 } : known ? { low, high: low } : undefined,
      walkMetres: j.walkMetres,
      parts,
    });
  });

  // Taxis, when the trip is longer than a walk.
  const crow = dist(from, to);
  let note: TaxiNote | undefined;
  if (crow >= 1500) {
    const km = (crow * 1.35) / 1000; // streets are longer than a straight line
    // ~25 km/h in town, ~60 km/h on the open road past that, plus a few minutes to find one.
    const drive = (Math.min(km, 8) / 25 + Math.max(0, km - 8) / 60) * 3600;
    const find = 240;
    const at = net.airportTaxi;
    const toTown = townOf(net, to);
    const airportFare = at && dist(from, at.at) < at.radius && toTown ? at.fares.find((f) => f.to.some((n) => normalizeName(n) === normalizeName(toTown))) : undefined;
    if (airportFare) {
      options.push({ kind: "airportTaxi", seconds: drive + find, range: [drive * 0.85 + 60, drive * 1.4 + 480], cost: { low: airportFare.dh, high: airportFare.dh }, walkMetres: 0, parts: [{ k: "wait", s: find }, { k: "ride", s: drive, colour: TAXI }], perCar: true });
    } else if (net.petitTaxi) {
      const pt = net.petitTaxi;
      const fromTown = townOf(net, from);
      if (fromTown && toTown && fromTown !== toTown) note = { kind: "otherTown", town: toTown };
      else {
        const hour = now.getHours();
        const night = hour >= pt.nightFrom || hour < pt.nightTo ? 1 + pt.night : 1;
        const meter = (f: number) => Math.round(Math.max(pt.minFare, pt.start + pt.perKm * km * f) * night);
        options.push({ kind: "petitTaxi", seconds: drive + find, range: [drive * 0.85 + 60, drive * 1.4 + 480], nightRate: night > 1, cost: { low: meter(0.85), high: meter(1.2) }, walkMetres: 0, parts: [{ k: "wait", s: find }, { k: "ride", s: drive, colour: TAXI }] });
      }
    }
  }
  return { options, note, night: isNight(now) && options.some((o) => o.kind === "transit") };
}

/**
 * Options nobody should pick: another option is at least as good on time,
 * price and walking, and clearly better on one. A price nobody publishes
 * can't be compared, so it's left out of that check.
 */
export function paretoFront(options: Option[]): Option[] {
  const beats = (b: Option, a: Option) => {
    const costKnown = a.cost && b.cost;
    const notWorse = b.seconds <= a.seconds + 30 && b.walkMetres <= a.walkMetres + 30 && (!costKnown || mid(b) <= mid(a) + 0.25);
    const better = b.seconds < a.seconds - 120 || b.walkMetres < a.walkMetres - 150 || (costKnown && mid(b) < mid(a) - 1);
    return notWorse && better;
  };
  return options.filter((a) => !options.some((b) => b !== a && beats(b, a)));
}

const mid = (o: Option) => (o.cost ? (o.cost.low + o.cost.high) / 2 : Infinity);

/** Sort by what matters to the rider; ties go to the faster option. */
export function rank(options: Option[], by: Priority): Option[] {
  const key = (o: Option) => (by === "fast" ? o.seconds : by === "cheap" ? mid(o) : o.walkMetres);
  return [...options].sort((a, b) => key(a) - key(b) || a.seconds - b.seconds);
}

/** Which option wins each measure (only one winner per measure, none when tied by all). */
export function winners(options: Option[]) {
  const best = (f: (o: Option) => number) => {
    let w: Option | undefined;
    for (const o of options) if (Number.isFinite(f(o)) && (!w || f(o) < f(w))) w = o;
    return w;
  };
  return { fast: best((o) => o.seconds), cheap: best(mid), walk: best((o) => o.walkMetres) };
}
