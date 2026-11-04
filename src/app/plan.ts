import { dist, type LngLat } from "../geo.ts";
import { t } from "../i18n.ts";
import { expandShortUrl, parseInput, type Parsed } from "../geoinput.ts";
import { meEndpoint, net, nm, render, router, state, type Endpoint } from "./state.ts";
import { flash, toast } from "./chrome.ts";
import { go, setStack } from "./nav.ts";
import { locate } from "./location.ts";

// ---------- endpoints and planning ----------
export async function setEndpoint(field: "from" | "to", ep: Endpoint) {
  state[field] = ep;
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

export function plan() {
  if (!state.from || !state.to) return;
  state.journeys = router.plan(state.from.ll, state.to.ll, { skipBrt: skipBrt() });
  setStack([{ name: "results" }]);
  writeHash();
  render();
}

export function swap() {
  [state.from, state.to] = [state.to, state.from];
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
      const ex = await expandShortUrl(r.shortUrl);
      r = { ...ex, name: r.name ?? ex.name };
    } catch {
      flash(t("linkFailed"));
      return;
    }
  }
  if (!r.ll) {
    flash(t("linkFailed"));
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
  if (!p.ll && !p.shortUrl) return flash(t("pasteNothing"), 5000);
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
  if (from && to) {
    state.from = from;
    state.to = to;
    plan();
  }
}
