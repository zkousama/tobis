import type { LngLat } from "./geo.ts";

export interface Names {
  d?: string; // default `name` tag
  fr?: string;
  ar?: string;
  en?: string;
  zgh?: string; // Tifinagh
  k?: string; // an app phrase ("my location"): shown in the current language, not frozen in the one it was made in
}

export interface Stop {
  id: number; // OSM node id
  ll: LngLat;
  n: Names;
  near?: number; // index into places: closest landmark
  area?: number; // index into places: neighbourhood or town
}

export interface Place {
  ll: LngLat;
  n: Names;
  k: "town" | "area" | "airport" | "station" | "school" | "health" | "shop" | "hotel" | "leisure" | "poi" | "street" | "food" | "bank" | "gov" | "worship";
  t?: string; // specific type: OSM amenity/shop value or Overture category
  src?: "ov"; // from Overture rather than OSM
  in?: number; // index into places: nearest other town
}

export interface Variant {
  rel: number | string; // OSM relation id, or "alsa:<line>:<direction>"
  from: string;
  to: string;
  shape: LngLat[];
  stops: number[]; // indexes into Network.stops, in travel order
  along: number[]; // metres along `shape` for each stop
  length: number;
  breaks?: number[]; // k: the section from stops[k] to stops[k+1] isn't trusted
  inferred?: "opposite" | "chain"; // stop order rebuilt because OSM's was scrambled
  zones?: number[]; // fare zone of each stop, for lines priced by zone
}

export type LineFare =
  | { kind: "flat"; normal: number; card?: number; transfer?: number; firstCard?: number; perSeat?: boolean }
  | { kind: "zones"; zones: { fr: string; ar?: string }[]; normal: Record<string, number>; card: Record<string, number> };

export interface Line {
  ref: string;
  brt: boolean;
  name: string;
  colour: string;
  variants: Variant[];
  fare?: LineFare;
  headway?: number; // minutes between buses, when the operator publishes it
  // Service hours ("06:00"), only when the operator publishes them and they look real: the Trambus,
  // and ALSA lines whose hours span a real day (most ALSA lines carry the same 6:25-10:30 filler).
  hours?: { first?: string; last?: string };
  taxi?: boolean; // a grand taxi route: leaves its stand when full
  // From the data council (scripts/council.mjs): what this line's data rests on, and changes riders
  // report that no credible source confirms yet.
  sources?: { name: string; date: string; url?: string }[];
  notices?: { what: string; confirmed?: boolean; text: string | Partial<Record<"fr" | "ar" | "en", string>>; source: string; date: string; url?: string }[];
}

export interface Network {
  alsaFetched?: string;
  petitTaxi?: { start: number; perKm: number; minFare: number; night: number; nightFrom: number; nightTo: number }; // meter, estimated
  communes?: { n: Names; rings: LngLat[][] }[]; // commune outlines, for taxi rules
  airportTaxi?: { at: [number, number]; radius: number; fares: { dh: number; to: string[] }[] }; // ONDA's fixed prices
  city: string;
  name: Names & Record<string, string>;
  bbox: [number, number, number, number];
  center: LngLat;
  zoom: number;
  osmTimestamp?: string;
  stops: Stop[];
  places: Place[];
  lines: Line[];
}

export function nameOf(n: Names, lang: string): string {
  if (lang === "ar") return n.ar ?? n.d ?? n.fr ?? n.en ?? "";
  if (lang === "en") return n.en ?? n.d ?? n.fr ?? n.ar ?? "";
  return n.fr ?? n.d ?? n.en ?? n.ar ?? "";
}
