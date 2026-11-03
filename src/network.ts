import type { LngLat } from "./geo.ts";

export interface Names {
  d?: string; // default `name` tag
  fr?: string;
  ar?: string;
  en?: string;
  zgh?: string; // Tifinagh
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
  k: "town" | "area" | "airport" | "station" | "school" | "health" | "shop" | "hotel" | "leisure" | "poi";
  in?: number; // index into places: nearest other town
}

export interface Variant {
  rel: number; // OSM relation id
  from: string;
  to: string;
  shape: LngLat[];
  stops: number[]; // indexes into Network.stops, in travel order
  along: number[]; // metres along `shape` for each stop
  length: number;
  breaks?: number[]; // k: the section from stops[k] to stops[k+1] isn't trusted
  inferred?: "opposite" | "chain"; // stop order rebuilt because OSM's was scrambled
}

export interface Line {
  ref: string;
  brt: boolean;
  name: string;
  colour: string;
  variants: Variant[];
}

export interface Network {
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
