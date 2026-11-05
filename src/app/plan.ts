import { dist, type LngLat } from "../geo.ts";
import { t } from "../i18n.ts";
import { expandShortUrl, parseInput, type Parsed } from "../geoinput.ts";
import { current, meEndpoint, net, nm, render, router, search, state, type Endpoint } from "./state.ts";
import { flash, toast } from "./chrome.ts";
import { go, setStack } from "./nav.ts";
import { locate } from "./location.ts";

// ---------- endpoints and planning ----------
export async function setEndpoint(field: "from" | "to", ep: Endpoint) {
  state[field] = ep;
  // A stop picked for the old start or end means nothing for the new one.
  if (field === "from") state.boardStop = undefined;
  else state.alightStop = undefined;
  if (field === "to" && ep.kind !== "me") remember(ep);
  // Like a maps app: once you say where you're going, start from where you are.
  if (field === "to" && !state.from) {
    if (!state.me) flash(t("locating"), 12000);
    const ll = state.me?.ll ?? (await locate(false));
    if (ll) state.from = meEndpoint(ll);
  }
  if (state.from && state.to) return plan();
  setStack([]);
  if (!state.from) {
    flash(t("setStart"));
    return go({ name: "search", field: "from" });
  }
  render();
}

/** The moment the trip starts: now, the chosen departure, or (arrive by) worked out from the trips found. */
export function startTime(): Date {
  const w = state.when;
  return new Date(w.mode === "now" ? Date.now() : w.at);
}
function planOptions(at: Date) {
  const avoid = new Set<number>();
  const refs = avoidedLines();
  net.lines.forEach((l, i) => refs.includes(l.ref) && avoid.add(i));
  return { skipBrt: skipBrt(), skipBus: skipBus(), avoid, at, boardStop: state.boardStop, alightStop: state.alightStop };
}
export function replan() {
  if (!state.from || !state.to) return;
  // Like a maps app: if no bus is within the usual walk, look further (about 30, then 50 minutes on foot).
  for (const maxAccess of [undefined, 2500, 4000]) {
    planWithin(maxAccess);
    state.widened = maxAccess;
    if (state.journeys.some((j) => j.rides > 0)) return;
  }
}
function planWithin(maxAccess: number | undefined) {
  if (!state.from || !state.to) return;
  const w = state.when;
  if (w.mode === "arrive") {
    // Arrive by: plan from an hour before, then again from when the slowest likely trip would have to leave.
    const first = router.plan(state.from.ll, state.to.ll, { ...planOptions(new Date(w.at - 3600_000)), maxAccess });
    const longest = Math.max(1200, ...first.map((j) => j.seconds));
    state.journeys = router.plan(state.from.ll, state.to.ll, { ...planOptions(new Date(w.at - longest * 1000 * 1.5)), maxAccess });
  } else state.journeys = router.plan(state.from.ll, state.to.ll, { ...planOptions(startTime()), maxAccess });
}
export function plan() {
  if (!state.from || !state.to) return;
  replan();
  rememberTrip(state.from, state.to);
  setStack([{ name: "results" }]);
  writeHash();
  render();
}

/** Forget the current trip: both ends (unless the start is "my location"), time, picked stops, the saved last trip. */
export function clearTripState() {
  state.to = undefined;
  if (state.from?.kind !== "me") state.from = undefined;
  state.journeys = [];
  state.boardStop = state.alightStop = undefined;
  state.when = { mode: "now" };
  state.widened = undefined;
  try {
    localStorage.removeItem("lastTrip");
  } catch {}
  if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
}
/** The ✕ on the results: start again from an empty home. */
export function newTrip() {
  clearTripState();
  setStack([]);
  render();
}

export function swap() {
  [state.from, state.to] = [state.to, state.from];
  state.boardStop = state.alightStop = undefined;
  if (state.from && state.to) plan();
  else render();
}

export function remember(ep: Endpoint) {
  try {
    const list: Endpoint[] = JSON.parse(localStorage.getItem("recent") ?? "[]");
    const next = [ep, ...list.filter((e) => nm(e.label) !== nm(ep.label) || dist(e.ll, ep.ll) > 50)].slice(0, 6);
    localStorage.setItem("recent", JSON.stringify(next));
  } catch {}
}
// ---------- usual trips: the ones planned again and again ----------
interface Usual {
  from: Endpoint; // kind "me": from wherever the rider is at the time
  to: Endpoint;
  n: number;
  last: number;
}
const tripKey = (from: Endpoint, to: Endpoint) => `${from.kind === "me" ? "me" : from.ll.map((x) => x.toFixed(3)).join(",")}>${to.ll.map((x) => x.toFixed(3)).join(",")}`;
export function usualTrips(): Usual[] {
  try {
    const all: Record<string, Usual> = JSON.parse(localStorage.getItem("trips") ?? "{}");
    return Object.values(all)
      .filter((u) => u.n >= 2)
      .sort((a, b) => b.n - a.n || b.last - a.last)
      .slice(0, 3);
  } catch {
    return [];
  }
}
// Counted once per hour at most, so replanning the same trip (options, time) isn't "using it again".
function rememberTrip(from: Endpoint, to: Endpoint) {
  if (to.kind === "me") return;
  try {
    const all: Record<string, Usual> = JSON.parse(localStorage.getItem("trips") ?? "{}");
    const k = tripKey(from, to);
    const u = all[k];
    if (u && Date.now() - u.last < 3600_000) return;
    all[k] = { from: from.kind === "me" ? { ...from, ll: [0, 0] } : from, to, n: (u?.n ?? 0) + 1, last: Date.now() };
    // Keep the 30 most recent.
    const keep = Object.entries(all).sort((a, b) => b[1].last - a[1].last).slice(0, 30);
    localStorage.setItem("trips", JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}
export function forgetTrips() {
  try {
    localStorage.removeItem("trips");
  } catch {}
}
/** Plan a usual trip again: from where the rider is now, if that's how it was saved. */
export async function planUsual(u: Usual) {
  if (u.from.kind === "me") {
    const ll = state.me?.ll ?? (await locate(false));
    if (!ll) return flash(t("locOff"));
    state.from = meEndpoint(ll);
  } else state.from = u.from;
  state.to = u.to;
  state.boardStop = state.alightStop = undefined;
  plan();
}

export function recents(): Endpoint[] {
  try {
    return JSON.parse(localStorage.getItem("recent") ?? "[]");
  } catch {
    return [];
  }
}

// ---------- links shared from Google Maps, pasted links, plus codes ----------
export async function resolveParsed(p: Parsed): Promise<Endpoint | undefined> {
  let r = p;
  if (r.shortUrl) {
    if (!navigator.onLine) {
      flash(t("linkNeedsNet"));
      return;
    }
    flash(t("opening"), 8000);
    try {
      const ex = await expandShortUrl(r.shortUrl, net.center);
      r = { ...ex, name: r.name ?? ex.name };
    } catch {
      flash(t("linkFailed"));
      return;
    }
  }
  if (!r.ll && r.name) {
    // Some Google links carry only a name (a place card, a search). Our own places may know it.
    const hit = search().search(r.name, net.center, 1)[0];
    if (hit?.ll && hit.score >= 0.8) {
      toast.classList.remove("show");
      return { ll: hit.ll, label: { d: r.name }, kind: "link", sub: t("fromGoogle") };
    }
    flash(t("linkNoPlace"), 9000);
    return;
  }
  if (!r.ll) {
    flash(t("linkFailed"), 9000);
    return;
  }
  toast.classList.remove("show");
  return { ll: r.ll, label: { d: r.name || t("sharedPlace") }, kind: "link", sub: t("fromGoogle") };
}

/** Opened from the share menu (Web Share Target): ?title=&text=&url= */
export async function handleShare(): Promise<boolean> {
  const q = new URLSearchParams(location.search);
  const shared = [q.get("title"), q.get("text"), q.get("url")].filter(Boolean).join("\n");
  if (!shared) return false;
  history.replaceState(null, "", location.pathname);
  const ep = await resolveParsed(parseInput(shared, net.center));
  if (ep) await setEndpoint("to", ep);
  return true;
}

export async function pasteFromClipboard(field: "from" | "to") {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return flash(t("pasteBlocked"), 5000);
  }
  const p = parseInput(text, state.me?.ll ?? net.center);
  // A link with only a place name still goes on: the name may be one of our places.
  if (!p.ll && !p.shortUrl && !(p.name && /https?:\/\//.test(text))) return flash(t("pasteNothing"), 5000);
  const ep = await resolveParsed(p);
  if (ep) setEndpoint(field, ep);
}

// The rider can leave the Trambus out of every plan (Settings).
export function skipBrt() {
  try {
    return localStorage.getItem("skipBrt") === "1";
  } catch {
    return false;
  }
}
// Only the Trambus: the rider turned buses off in the trip options.
export function skipBus() {
  try {
    return localStorage.getItem("skipBus") === "1";
  } catch {
    return false;
  }
}
export function setMode(key: "skipBrt" | "skipBus", off: boolean) {
  try {
    localStorage.setItem(key, off ? "1" : "0");
  } catch {}
}
/** Line refs the rider never wants suggested, kept between launches. */
export function avoidedLines(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("avoidLines") ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
export function setAvoided(refs: string[]) {
  try {
    localStorage.setItem("avoidLines", JSON.stringify(refs));
  } catch {}
}

// ---------- shareable links: #from=lon,lat&to=lon,lat ----------
export function writeHash() {
  if (!state.from || !state.to) return;
  const enc = (e: Endpoint) => `${e.ll[0].toFixed(5)},${e.ll[1].toFixed(5)}${e.kind !== "map" && e.kind !== "me" ? `,${encodeURIComponent(nm(e.label))}` : ""}`;
  const hash = `#from=${enc(state.from)}&to=${enc(state.to)}`;
  history.replaceState(null, "", hash);
  try {
    localStorage.setItem("lastTrip", JSON.stringify({ hash, at: Date.now() }));
  } catch {}
}
export const LAST_TRIP_MS = 2 * 3600 * 1000;
export function lastTripHash() {
  try {
    const j = JSON.parse(localStorage.getItem("lastTrip") ?? "null");
    if (j && Date.now() - j.at < LAST_TRIP_MS) return String(j.hash);
  } catch {}
  return "";
}
export function restoreFromHash() {
  const p = new URLSearchParams((location.hash || lastTripHash()).slice(1));
  const dec = (s: string | null): Endpoint | undefined => {
    if (!s) return;
    const [x, y, ...rest] = s.split(",");
    const ll: LngLat = [Number(x), Number(y)];
    if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return;
    const label = rest.length ? decodeURIComponent(rest.join(",")) : t("pointOnMap");
    return { ll, label: { d: label }, kind: rest.length ? "place" : "map" };
  };
  const from = dec(p.get("from"));
  const to = dec(p.get("to"));
  // This runs once the map has loaded; if the rider has already started something
  // (a search, a line), don't pull them away from it.
  if (current().name !== "home") return;
  if (from && to) {
    state.from = from;
    state.to = to;
    plan();
  }
}
