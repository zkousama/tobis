import type { BusMap } from "../map.ts";
import type { Router, Journey } from "../router.ts";
import { SearchIndex } from "../search.ts";
import { nameOf, type Names, type Network } from "../network.ts";
import type { LngLat } from "../geo.ts";
import { getLang, t } from "../i18n.ts";
import type { RideTracker } from "../ride.ts";

// Shared state and the pieces every screen reads. Bindings that other
// modules replace (the network once loaded, the map, the live ride) change
// through the setters below; reads see the current value.

export interface Endpoint {
  ll: LngLat;
  label: Names;
  kind: "me" | "place" | "stop" | "map" | "link";
  sub?: Names | string;
}
export type View =
  | { name: "home" }
  | { name: "search"; field: "from" | "to" }
  | { name: "results" }
  | { name: "trip"; index: number }
  | { name: "ride"; index: number }
  | { name: "lines" }
  | { name: "line"; line: number; variant: number }
  | { name: "stop"; stop: number }
  | { name: "point"; ll: LngLat }
  | { name: "pickStop"; which: "board" | "alight" }
  | { name: "about" }
  | { name: "help"; section?: string };

export const CITY = "agadir";
export const base = import.meta.env.BASE_URL;

export const state = {
  from: undefined as Endpoint | undefined,
  to: undefined as Endpoint | undefined,
  journeys: [] as Journey[],
  stack: [{ name: "home" }] as View[],
  me: undefined as { ll: LngLat; acc: number; at: number } | undefined,
  pickOnMap: undefined as "from" | "to" | undefined,
  sheet: "half" as "peek" | "half" | "full",
  locPerm: "prompt" as PermissionState | "unsupported",
  // When: now, leave at a time, or arrive by a time (epoch ms). Not kept between launches.
  when: { mode: "now" } as { mode: "now" } | { mode: "depart" | "arrive"; at: number },
  // Stops the rider chose to walk to or get off at, for this trip only.
  boardStop: undefined as number | undefined,
  alightStop: undefined as number | undefined,
  // Metres the last plan had to walk to find a bus, when that's more than usual.
  widened: undefined as number | undefined,
};

export let net: Network;
export let offlineMB = 0; // size of the offline copy, shown before anyone installs
export let appVersion = ""; // content hash of this build, shown in Settings for bug reports
export let router: Router;
export let searchIndex: SearchIndex | undefined;
export let bmap: BusMap | undefined;
// Built when the phone is idle, or on first use, whichever comes first.
export const search = () => (searchIndex ??= new SearchIndex(net));
export let ride: RideTracker | undefined;

export const nm = (n: Names | string | undefined) => (typeof n === "string" ? n : n ? nameOf(n, getLang()) : "");
export const meEndpoint = (ll: LngLat): Endpoint => ({ ll, label: { d: t("myLocation") }, kind: "me" });
export const setNet = (n: Network) => (net = n);
export const setRouter = (r: Router) => (router = r);
export const setBmap = (m: BusMap) => (bmap = m);
export const setRide = (r: RideTracker | undefined) => (ride = r);
export const setOfflineMB = (n: number) => (offlineMB = n);
export const setAppVersion = (v: string) => (appVersion = v);

export function current(): View {
  return state.stack[state.stack.length - 1];
}

// The screen switch lives in main.ts; views call render() through here.
let renderImpl = () => {};
export function setRender(f: () => void) {
  renderImpl = f;
}
export function render() {
  renderImpl();
}
