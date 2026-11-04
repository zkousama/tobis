import "./style.css";
import type { BusMap } from "./map.ts";
import { Router, waitFor, type Journey, type RideLeg, type WalkFn } from "./router.ts";
import { SearchIndex, type Hit } from "./search.ts";
import { nameOf, type Names, type Network } from "./network.ts";
import { bearing, dist, type LngLat } from "./geo.ts";
import { detectLang, fmtDistance, fmtMinutes, fmtStops, getLang, LANGS, setLang, t, typeLabel, type Key, type Lang } from "./i18n.ts";
import { h, icon, lineBadge } from "./ui/dom.ts";
import { visible } from "./ui/colour.ts";
import { RideTracker } from "./ride.ts";
import { loadWalkGraph } from "./walk.ts";
// The map library is the heaviest part: start fetching it right away, in parallel.
const mapModule = import("./map.ts");
import { registerOffline } from "./offline.ts";
import { getTheme, setTheme, type Theme } from "./theme.ts";
import { fareFor, fmtDH } from "./fares.ts";
import { expandShortUrl, parseInput, type Parsed } from "./geoinput.ts";
import { buildOptions, DEFAULT_VOT, learnVot, nearTie, paretoFront, recommend, tradeoff, VOT_RANGE, winners, type Option, type Part, type Prefs } from "./compare.ts";
import { walkPace } from "./pace.ts";

interface Endpoint {
  ll: LngLat;
  label: Names;
  kind: "me" | "place" | "stop" | "map" | "link";
  sub?: Names | string;
}
type View =
  | { name: "home" }
  | { name: "search"; field: "from" | "to" }
  | { name: "results" }
  | { name: "trip"; index: number }
  | { name: "ride"; index: number }
  | { name: "lines" }
  | { name: "line"; line: number; variant: number }
  | { name: "stop"; stop: number }
  | { name: "point"; ll: LngLat }
  | { name: "about" }
  | { name: "help"; section?: string };

const CITY = "agadir";
const base = import.meta.env.BASE_URL;

const state = {
  from: undefined as Endpoint | undefined,
  to: undefined as Endpoint | undefined,
  journeys: [] as Journey[],
  stack: [{ name: "home" }] as View[],
  me: undefined as { ll: LngLat; acc: number; at: number } | undefined,
  pickOnMap: undefined as "from" | "to" | undefined,
  sheet: "half" as "peek" | "half" | "full",
  locPerm: "prompt" as PermissionState | "unsupported",
};

// ---------- installing the app (it's a PWA) ----------
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
let installEvent: InstallPrompt | undefined;
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e as InstallPrompt;
  if (["home", "about", "help"].includes(current().name)) render();
});
addEventListener("appinstalled", () => {
  installEvent = undefined;
  render();
});
async function install() {
  if (!installEvent) return go({ name: "help", section: "install" });
  await installEvent.prompt();
  await installEvent.userChoice.catch(() => undefined);
  installEvent = undefined;
  render();
}
const canInstall = () => !standalone() && (!!installEvent || isIos);

setLang(detectLang());
const app = document.getElementById("app")!;
app.replaceChildren();

const mapEl = h("div", { id: "map" });
const sheetBody = h("div", { class: "sheet-body" });
const handle = h("button", { class: "sheet-handle", "aria-label": t("sheetResize"), "aria-expanded": "false" });
const sheet = h("section", { class: "sheet", "data-size": state.sheet }, handle, sheetBody);
// The map gets the screen: one settings button, no title bar.
const settingsBtn = h("button", { class: "map-btn", onclick: () => go({ name: "about" }) }, icon.menu(), h("span", { class: "map-btn-label" }, t("menuLabel")));
const topbar = h("header", { class: "topbar" }, settingsBtn);
// While the offline copy downloads: a thin bar along the top of the sheet.
const progressBar = h("div", { class: "sheet-progress", hidden: true, role: "progressbar", "aria-label": t("downloading") });
sheet.prepend(progressBar);
// No signal: a steady line at the top of the sheet for as long as it lasts.
const offlineBanner = h("p", { class: "offline-banner", role: "status", hidden: true }, icon.offline(), h("span", null, t("offlineNow")));
sheet.insertBefore(offlineBanner, sheetBody);
const locateBtn = h("button", { class: "fab fab-locate", "aria-label": t("myLocation"), onclick: () => locate(true) }, icon.locate());
const toast = h("div", { class: "toast", role: "status" });
app.append(mapEl, topbar, locateBtn, sheet, toast);

let net: Network;
let offlineMB = 0; // size of the offline copy, shown before anyone installs
let router: Router;
let searchIndex: SearchIndex | undefined;
let bmap: BusMap | undefined;
// Built when the phone is idle, or on first use, whichever comes first.
const search = () => (searchIndex ??= new SearchIndex(net));
let ride: RideTracker | undefined;

const nm = (n: Names | string | undefined) => (typeof n === "string" ? n : n ? nameOf(n, getLang()) : "");
const meEndpoint = (ll: LngLat): Endpoint => ({ ll, label: { d: t("myLocation") }, kind: "me" });

async function boot() {
  sheetBody.replaceChildren(h("div", { class: "loading" }, h("div", { class: "spinner" }), h("p", { class: "muted" }, t("loadingLines"))));
  performance.mark("boot");
  const res = await fetch(`${base}data/${CITY}.json`);
  performance.mark("fetched");
  net = await res.json();
  performance.mark("parsed");
  router = new Router(net); // straight-line walking until the street graph is in
  router.setWalkSpeed(walkPace());
  performance.mark("router");
  render(); // the planner is usable before the map has drawn
  performance.mark("rendered");
  watchLocationPermission();
  fetch(`${base}precache.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { sizes?: number[] } | null) => {
      if (j?.sizes) offlineMB = Math.round(j.sizes.reduce((a, b) => a + b, 0) / 1048576);
    })
    .catch(() => {});
  // Say what still works when the signal goes, once each time it happens.
  const signal = () => (offlineBanner.hidden = navigator.onLine);
  addEventListener("offline", signal);
  addEventListener("online", signal);
  signal();
  const { BusMap } = await mapModule;
  bmap = new BusMap(mapEl, net, getLang(), {
    onStop: (s) => go({ name: "stop", stop: s }),
    onLine: (l) => go({ name: "line", line: l, variant: 0 }),
    onPoint: (ll) => {
      if (state.pickOnMap) {
        const field = state.pickOnMap;
        state.pickOnMap = undefined;
        setEndpoint(field, { ll, label: { d: t("pointOnMap") }, kind: "map" });
        return;
      }
      go({ name: "point", ll });
    },
  });
  await bmap.ready;
  if (state.me) bmap?.setMe(state.me.ll, state.me.acc);
  render();
  registerOffline(onOfflineProgress, t);
  // Street walking: swap it in once loaded, and redo an open plan with it.
  loadWalkGraph(`${base}data/${CITY}-walk.bin`)
    .then((walk: WalkFn) => {
      router.setWalk(walk);
      if (current().name === "results" && state.from && state.to) plan();
    })
    .catch(() => {});
  (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300)))(() => search());
  if (!(await handleShare())) restoreFromHash();
}

// ---------- navigation ----------
function current(): View {
  return state.stack[state.stack.length - 1];
}
// Views ride on the browser history, so the phone's back button steps back
// through the app instead of closing it.
let historyDepth = 1;
function go(v: View, reset = false) {
  sheetEntry = false;
  if (reset) state.stack = [{ name: "home" }];
  if (v.name !== "home") {
    state.stack.push(v);
    history.pushState({ app: true }, "");
    historyDepth++;
  }
  render();
}
function back() {
  if (state.stack.length > 1) history.back();
}
addEventListener("popstate", () => {
  historyDepth = Math.max(1, historyDepth - 1);
  if (sheetEntry) {
    sheetEntry = false;
    setSheet("half");
    return;
  }
  if (state.stack.length > 1) state.stack.pop();
  ride?.stop();
  render();
});
/** Replace the view stack (after planning, or picking on the map). */
function setStack(views: View[]) {
  state.stack = [{ name: "home" }, ...views];
  if (views.length && historyDepth < state.stack.length) {
    history.pushState({ app: true }, "");
    historyDepth++;
  }
}
function setSheet(size: "peek" | "half" | "full") {
  state.sheet = size;
  sheet.dataset.size = size;
  handle.setAttribute("aria-expanded", size === "full" ? "true" : "false");
}
// A sheet the rider pulled open is a step Back can undo, like a screen.
let sheetEntry = false;
function userOpenedSheet() {
  if (sheetEntry || innerWidth >= 900) return;
  sheetEntry = true;
  history.pushState({ app: true, sheet: true }, "");
  historyDepth++;
}

// ---------- endpoints and planning ----------
async function setEndpoint(field: "from" | "to", ep: Endpoint) {
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

function plan() {
  if (!state.from || !state.to) return;
  state.journeys = router.plan(state.from.ll, state.to.ll);
  setStack([{ name: "results" }]);
  writeHash();
  render();
}

function swap() {
  [state.from, state.to] = [state.to, state.from];
  if (state.from && state.to) plan();
  else render();
}

function remember(ep: Endpoint) {
  try {
    const list: Endpoint[] = JSON.parse(localStorage.getItem("recent") ?? "[]");
    const next = [ep, ...list.filter((e) => nm(e.label) !== nm(ep.label) || dist(e.ll, ep.ll) > 50)].slice(0, 6);
    localStorage.setItem("recent", JSON.stringify(next));
  } catch {}
}
function recents(): Endpoint[] {
  try {
    return JSON.parse(localStorage.getItem("recent") ?? "[]");
  } catch {
    return [];
  }
}

// ---------- location ----------
const LOC_ERRORS = { 1: "locDenied", 2: "locOff", 3: "locTimeout" } as const;
function locate(fly: boolean, quiet = false): Promise<LngLat | undefined> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      if (!quiet) flash(t("locOff"));
      return resolve(undefined);
    }
    if (fly) flash(t("locating"), 12000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const ll: LngLat = [p.coords.longitude, p.coords.latitude];
        state.me = { ll, acc: p.coords.accuracy, at: Date.now() };
        state.locPerm = "granted";
        bmap?.setMe(ll, p.coords.accuracy);
        if (fly) bmap?.flyTo(ll, 16);
        toast.classList.remove("show");
        if (current().name === "home" || current().name === "search") refreshPlanner();
        resolve(ll);
      },
      (err) => {
        if (err.code === 1) state.locPerm = "denied";
        if (!quiet) flash(t(LOC_ERRORS[err.code as 1 | 2 | 3] ?? "noGps"), 6000);
        resolve(undefined);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}
/** If location is already allowed, find the user quietly so "from" is ready. */
function watchLocationPermission() {
  if (!navigator.permissions?.query) {
    state.locPerm = "unsupported";
    return;
  }
  navigator.permissions
    .query({ name: "geolocation" })
    .then((p) => {
      state.locPerm = p.state;
      if (p.state === "granted") locate(false, true);
      p.onchange = () => {
        state.locPerm = p.state;
        if (p.state === "granted") locate(false, true);
        if (current().name === "home") render();
      };
      if (current().name === "home") render();
    })
    .catch(() => (state.locPerm = "unsupported"));
}
let refreshPlanner = () => {};

// ---------- offline copy ----------
let offline = { done: 0, total: 0 };
function onOfflineProgress(done: number, total: number) {
  const wasDownloading = offline.total > 0 && offline.done < offline.total;
  offline = { done, total };
  const complete = done >= total;
  progressBar.hidden = complete;
  progressBar.style.setProperty("--p", `${Math.floor((done / Math.max(1, total)) * 100)}%`);
  // Say it once, when it becomes true; after that it's in Settings.
  if (complete && wasDownloading) flash(t("offlineReady"), 4000);
  if (current().name === "about") render();
}

let toastTimer = 0;
function flash(msg: string, ms = 5000) {
  // Like a snackbar: one at a time, just above the sheet.
  const above = innerWidth >= 900 ? 24 : sheet.getBoundingClientRect().height + 12;
  toast.style.bottom = `${above}px`;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), ms);
}

// ---------- links shared from Google Maps, pasted links, plus codes ----------
async function resolveParsed(p: Parsed): Promise<Endpoint | undefined> {
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
async function handleShare(): Promise<boolean> {
  const q = new URLSearchParams(location.search);
  const shared = [q.get("title"), q.get("text"), q.get("url")].filter(Boolean).join("\n");
  if (!shared) return false;
  history.replaceState(null, "", location.pathname);
  const ep = await resolveParsed(parseInput(shared, net.center));
  if (ep) await setEndpoint("to", ep);
  return true;
}

// ---------- rendering ----------
function render() {
  const v = current();
  document.title = t("appName");
  // The pieces that live outside the sheet body follow a language change too.
  settingsBtn.lastElementChild!.textContent = t("menuLabel");
  offlineBanner.lastElementChild!.textContent = t("offlineNow");
  handle.setAttribute("aria-label", t("sheetResize"));
  locateBtn.setAttribute("aria-label", t("myLocation"));
  sheetBody.replaceChildren();
  sheet.className = `sheet view-${v.name}`;
  ride?.stop();
  ride = undefined;
  if (v.name !== "trip" && v.name !== "results" && v.name !== "ride") bmap?.clearTrip();
  if (v.name !== "line") bmap?.clearFocus();
  bmap?.showNetwork(["home", "lines", "stop", "point", "search"].includes(v.name));
  switch (v.name) {
    case "home":
      setSheet(state.sheet === "full" ? "half" : state.sheet);
      sheetBody.append(planner("home"), homeBody());
      bmap?.setPins(state.from?.ll, state.to?.ll);
      break;
    case "search":
      setSheet("full");
      sheetBody.append(planner("search", v.field), searchBody(v.field));
      break;
    case "results":
      setSheet("half");
      sheetBody.append(planner("results"), resultsBody());
      if (state.journeys[0]) previewTrip(0);
      else bmap?.setPins(state.from?.ll, state.to?.ll);
      break;
    case "trip":
      try {
        localStorage.setItem("tripsSeen", String((Number(localStorage.getItem("tripsSeen")) || 0) + 1));
      } catch {}
      setSheet("half");
      sheetBody.append(tripBody(v.index));
      previewTrip(v.index);
      break;
    case "ride":
      setSheet("peek");
      sheetBody.append(rideBody(v.index));
      previewTrip(v.index);
      break;
    case "lines":
      setSheet("full");
      sheetBody.append(linesBody());
      break;
    case "line":
      setSheet("half");
      sheetBody.append(lineBody(v.line, v.variant));
      bmap?.showLine(v.line, v.variant);
      break;
    case "stop":
      setSheet("half");
      sheetBody.append(stopBody(v.stop));
      bmap?.flyTo(net.stops[v.stop].ll, Math.max((bmap?.map.getZoom() ?? 16), 16));
      break;
    case "point":
      setSheet("half");
      sheetBody.append(pointBody(v.ll));
      bmap?.setPins(undefined, v.ll);
      break;
    case "about":
      setSheet("full");
      sheetBody.append(aboutBody());
      break;
    case "help":
      setSheet("full");
      sheetBody.append(helpBody(v.section));
      break;
  }
}

function header(title: Node | string, sub?: Node | string | null) {
  return h(
    "div",
    { class: "view-head" },
    h("button", { class: "icon-btn", "aria-label": t("back"), onclick: back }, icon.back()),
    h("div", { class: "view-title" }, h("h2", null, title), sub ? h("p", { class: "muted" }, sub) : null),
  );
}

// Home shows only "Where to?"; search shows the field being typed in; results
// show both ends and the swap button.
function planner(mode: "home" | "search" | "results", active?: "from" | "to") {
  const field = (which: "from" | "to") => {
    const ep = state[which];
    const isActive = active === which;
    // "From" quietly means "where I am" once the phone has a position.
    const placeholder = which === "to" ? t("whereTo") : state.me ? t("myLocation") : t("from");
    const input = h("input", {
      class: "field-input",
      type: "text",
      inputmode: "search",
      placeholder,
      value: isActive ? "" : nm(ep?.label),
      "aria-label": which === "to" ? t("to") : t("from"),
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: false,
      autocorrect: "off",
      enterkeyhint: "search",
      onfocus: () => {
        const cur = current();
        if (cur.name !== "search" || cur.field !== which) go({ name: "search", field: which });
      },
      oninput: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        clear.hidden = !v;
        // Wait for a short pause in typing, so slower phones stay smooth.
        clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => updateSearch(which, v), v.length < 3 ? 0 : 60);
      },
      onkeydown: (e: KeyboardEvent) => {
        // Enter picks the first suggestion, like a maps app.
        if (e.key === "Enter") (searchList?.querySelector(".row") as HTMLButtonElement | null)?.click();
      },
      onpaste: (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text") ?? "";
        const p = parseInput(text, state.me?.ll ?? net.center);
        if (p.ll || p.shortUrl) {
          e.preventDefault();
          resolveParsed(p).then((ep) => ep && setEndpoint(which, ep));
        }
      },
    });
    const clear = h(
      "button",
      {
        class: "field-clear",
        type: "button",
        "aria-label": t("clear"),
        hidden: !isActive,
        onclick: (e: Event) => {
          e.preventDefault();
          input.value = "";
          clear.hidden = true;
          updateSearch(which, "");
          input.focus();
        },
      },
      icon.close(),
    );
    if (isActive) queueMicrotask(() => input.focus({ preventScroll: true }));
    const meDot = which === "from" && !ep && state.me ? h("span", { class: "me-live", title: t("youAreHere") }) : null;
    // Once both ends are filled in, a small label keeps each one's meaning.
    const field = mode === "results" ? h("span", { class: "field-stack" }, h("small", { class: "field-label" }, which === "to" ? t("to") : t("from")), input) : input;
    return h("label", { class: `field field-${which}${isActive ? " active" : ""}` }, h("span", { class: `dot dot-${which}` }), field, meDot, clear);
  };
  const fields = mode === "home" ? [field("to")] : mode === "search" ? [field(active ?? "to")] : [field("from"), field("to")];
  const el = h(
    "div",
    { class: `planner planner-${mode}` },
    mode === "search" ? h("button", { class: "icon-btn planner-back", "aria-label": t("cancel"), onclick: back }, icon.back()) : null,
    h("div", { class: "fields" }, fields),
    mode === "results" ? h("button", { class: "icon-btn swap", "aria-label": t("swap"), onclick: swap }, icon.swap()) : null,
  );
  refreshPlanner = () => {
    if (current().name === "results") el.replaceWith(planner("results"));
  };
  return el;
}

function homeBody() {
  const rec = recents();
  const brt = net.lines.findIndex((l) => l.brt);
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("installDismissed") === "1";
  } catch {}
  const cards: Node[] = [];
  // Location: ask once, with a reason, rather than a surprise browser prompt.
  if (!state.me && state.locPerm !== "granted")
    cards.push(
      h(
        "button",
        { class: "tip", onclick: () => locate(true) },
        h("span", { class: "row-icon accent" }, icon.locate()),
        h("span", { class: "row-main" }, h("strong", null, t("useMyLocation")), h("small", { class: "muted" }, state.locPerm === "denied" ? t("locDenied") : t("useMyLocationSub"))),
      ),
    );
  let tripsSeen = 0;
  try {
    tripsSeen = Number(localStorage.getItem("tripsSeen")) || 0;
  } catch {}
  // Offer the install after the app has been useful once, never on first open.
  if (canInstall() && !dismissed && tripsSeen > 0)
    cards.push(
      h(
        "div",
        { class: "tip tip-install" },
        h("span", { class: "row-icon" }, icon.offline()),
        h("span", { class: "row-main" }, h("strong", null, t("installCard")), offlineMB ? h("small", { class: "muted" }, t("offlineSize", offlineMB)) : null),
        h("button", { class: "btn btn-small btn-primary", onclick: install }, t("installNow")),
        h(
          "button",
          {
            class: "link",
            onclick: () => {
              try {
                localStorage.setItem("installDismissed", "1");
              } catch {}
              render();
            },
          },
          t("later"),
        ),
      ),
    );
  return h(
    "div",
    { class: "home" },
    cards.length ? h("div", { class: "tips" }, cards) : null,
    h(
      "div",
      { class: "quick" },
      brt >= 0
        ? h(
            "button",
            { class: "quick-card quick-brt", onclick: () => go({ name: "line", line: brt, variant: 0 }) },
            lineBadge("BHNS", net.lines[brt].colour),
            h("span", { class: "serif" }, `${net.lines[brt].variants[0].from} – ${net.lines[brt].variants[0].to}`),
            net.lines[brt].headway ? h("small", null, t("noteWait", net.lines[brt].headway)) : null,
          )
        : null,
      h(
        "button",
        { class: "quick-card", onclick: () => go({ name: "lines" }) },
        h("span", { class: "row-icon" }, icon.bus()),
        h("span", { class: "serif" }, t("allLines")),
        h("small", null, `${net.lines.length} ${t("lines").toLowerCase()}`),
      ),
    ),
    rec.length
      ? h(
          "div",
          { class: "section" },
          h("h3", { class: "section-title label" }, t("recent")),
          h(
            "ul",
            { class: "list" },
            rec.map((ep) =>
              h(
                "li",
                null,
                h("button", { class: "row", onclick: () => setEndpoint("to", ep) }, h("span", { class: "row-icon" }, icon.clock()), h("span", { class: "row-main" }, h("span", null, nm(ep.label)), ep.sub ? h("small", { class: "muted" }, nm(ep.sub)) : null)),
              ),
            ),
          ),
        )
      : null,
    h("button", { class: "cta", onclick: () => go({ name: "help" }) }, h("span", { class: "plus" }, "?"), t("helpLink")),
    dataNote(),
  );
}

function dataNote() {
  const d = net.osmTimestamp ? new Date(net.osmTimestamp) : undefined;
  const lang = getLang() === "ar" ? "ar-MA" : getLang();
  return h("p", { class: "fine" }, `${t("dataFrom")} ${d ? d.toLocaleDateString(lang) : "?"}. ${t("estimates")}`);
}

async function pasteFromClipboard(field: "from" | "to") {
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

let searchTimer = 0;
let searchList: HTMLElement | undefined;
let pasteRow: HTMLElement | undefined;
let cantFind: HTMLElement | undefined;
function searchBody(field: "from" | "to") {
  searchList = h("ul", { class: "list results-list" });
  pasteRow = h("div", { hidden: true });
  cantFind = h(
    "div",
    { class: "tip tip-help", hidden: true },
    h("span", { class: "row-main" }, h("strong", null, t("cantFindTitle")), h("small", null, t("cantFindText"))),
    h("div", { class: "tip-actions" }, h("button", { class: "btn btn-small btn-primary", onclick: () => pasteFromClipboard(field) }, t("pasteLink")), h("button", { class: "link", onclick: () => go({ name: "help", section: "find" }) }, t("howTo"))),
  );
  const locSub = state.me ? fmtDistance(state.me.acc) + " ±" : state.locPerm === "denied" ? t("locDenied") : null;
  const box = h(
    "div",
    { class: "search" },
    pasteRow,
    searchList,
    cantFind,
    h(
      "div",
      { class: "search-actions" },
      h(
        "button",
        {
          class: "row",
          onclick: async () => {
            const ll = state.me?.ll ?? (await locate(false));
            if (ll) setEndpoint(field, meEndpoint(ll));
          },
        },
        h("span", { class: "row-icon accent" }, icon.locate()),
        h("span", { class: "row-main" }, h("span", null, t("myLocation")), locSub ? h("small", { class: "muted" }, locSub) : null),
      ),
      h(
        "button",
        {
          class: "row",
          onclick: () => {
            state.pickOnMap = field;
            setStack([]);
            render();
            setSheet("peek");
            flash(t("tapMap"), 6000);
          },
        },
        h("span", { class: "row-icon" }, icon.pin()),
        h("span", { class: "row-main" }, h("span", null, t("pointOnMap"))),
      ),
      h(
        "button",
        { class: "row", onclick: () => pasteFromClipboard(field) },
        h("span", { class: "row-icon" }, icon.link()),
        h("span", { class: "row-main" }, h("span", null, t("pasteLink")), h("small", { class: "muted" }, t("pasteHint"))),
      ),
    ),
    h("p", { class: "fine" }, t("searchHint")),
  );
  queueMicrotask(() => updateSearch(field, ""));
  return box;
}

function updateSearch(field: "from" | "to", q: string) {
  if (!searchList || !pasteRow || !cantFind) return;
  // A typed or pasted link, plus code or coordinates.
  const parsed = parseInput(q, state.me?.ll ?? net.center);
  pasteRow.hidden = !(parsed.ll || parsed.shortUrl);
  pasteRow.replaceChildren(
    h(
      "button",
      { class: "row", onclick: () => resolveParsed(parsed).then((ep) => ep && setEndpoint(field, ep)) },
      h("span", { class: "row-icon accent" }, icon.pin()),
      h("span", { class: "row-main" }, h("span", null, t("useThis")), h("small", { class: "muted" }, parsed.name ?? q.slice(0, 60))),
    ),
  );
  const near = state.me?.ll ?? net.center;
  const hits = q.trim() ? search().search(q, near, 12) : [];
  if (!q.trim()) {
    // Before typing: the places you went to before.
    const rec = recents();
    searchList.replaceChildren(
      ...rec.map((ep) =>
        h("li", null, h("button", { class: "row", onclick: () => setEndpoint(field, ep) }, h("span", { class: "row-icon" }, icon.clock()), h("span", { class: "row-main" }, h("span", null, nm(ep.label)), ep.sub ? h("small", { class: "muted" }, nm(ep.sub)) : null))),
      ),
      ...(rec.length
        ? [
            h(
              "li",
              null,
              h(
                "button",
                {
                  class: "link clear-history",
                  onclick: () => {
                    try {
                      localStorage.removeItem("recent");
                      localStorage.removeItem("lastTrip");
                    } catch {}
                    searchList?.replaceChildren();
                  },
                },
                t("clearHistory"),
              ),
            ),
          ]
        : []),
    );
  } else searchList.replaceChildren(...hits.map((hit) => h("li", null, hitRow(hit, field, near))));
  // Typed a couple of letters: if the place isn't here, show the way round it.
  cantFind.hidden = q.trim().length < 3 || !pasteRow.hidden;
  cantFind.classList.toggle("tip-strong", !hits.length);
}

const KIND_ICON: Record<string, () => HTMLElement> = { street: icon.arrow };
function hitRow(hit: Hit, field: "from" | "to", near: LngLat) {
  if (hit.kind === "line") {
    const l = net.lines[hit.index];
    return h("button", { class: "row", onclick: () => go({ name: "line", line: hit.index, variant: 0 }) }, lineBadge(l.ref, l.colour, "sm"), h("span", { class: "row-main" }, h("span", null, nm(hit.sub))));
  }
  const place = hit.kind === "place" ? net.places[hit.index] : undefined;
  const ic = hit.kind === "stop" ? icon.stop() : (KIND_ICON[place?.k ?? ""] ?? icon.place)();
  const type = hit.kind === "stop" ? t("stop") : typeLabel(place?.k, place?.t);
  const subBits = [type, nm(hit.sub), hit.ll ? fmtDistance(dist(near, hit.ll)) : ""].filter(Boolean);
  return h(
    "button",
    { class: "row", onclick: () => setEndpoint(field, { ll: hit.ll!, label: hit.label, kind: hit.kind === "stop" ? "stop" : "place", sub: [type, nm(hit.sub)].filter(Boolean).join(" · ") }) },
    h("span", { class: "row-icon kind-icon" }, ic),
    h("span", { class: "row-main" }, h("span", null, nm(hit.label)), h("small", { class: "muted" }, subBits.join(" · "))),
    hit.kind === "stop" ? linesAt(hit.index, 4) : null,
  );
}

function linesAt(stop: number, max = 99) {
  const refs = new Map<number, string>();
  const s = net.stops[stop];
  net.stops.forEach((o, oi) => {
    if (oi !== stop && !(o.n.d === s.n.d && dist(o.ll, s.ll) < 120)) return;
    net.lines.forEach((l, li) => l.variants.forEach((v) => v.stops.includes(oi) && refs.set(li, l.ref)));
  });
  const items = [...refs.keys()].slice(0, max);
  return h("span", { class: "badges" }, items.map((li) => lineBadge(net.lines[li].ref, net.lines[li].colour, "sm")), refs.size > max ? h("small", { class: "muted" }, `+${refs.size - max}`) : null);
}

function legChips(j: Journey) {
  const parts: Node[] = [];
  j.legs.forEach((l, i) => {
    if (i) parts.push(h("span", { class: "chev" }, icon.chevron()));
    if (l.kind === "walk") parts.push(h("span", { class: "walk-chip" }, icon.walk(), h("span", null, Math.max(1, Math.round(l.seconds / 60)))));
    else parts.push(lineBadge(net.lines[l.line].ref, net.lines[l.line].colour, "sm"));
  });
  return h("div", { class: "legs" }, parts);
}

const variantOf = (l: RideLeg) => net.lines[l.line].variants[l.variant];

function journeyFare(j: Journey) {
  let total = 0;
  for (const l of j.legs) {
    if (l.kind !== "ride") continue;
    const f = fareFor(net.lines[l.line], variantOf(l), l.board, l.alight);
    if (!f) return undefined;
    total += f.normal;
  }
  return total || undefined;
}

function resultsBody() {
  const to = state.to;
  const nearest = to ? router.stopsNear(to.ll, 900).slice(0, 40) : [];
  // One row per stop name: the closest platform.
  const seen = new Set<string>();
  const near = nearest.filter((x) => {
    const k = net.stops[x.stop].n.d ?? String(x.stop);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 4);
  const nearBlock = near.length
    ? h(
        "div",
        { class: "section" },
        h("h3", { class: "section-title label" }, t("stopsNearDest")),
        h(
          "ul",
          { class: "list stop-near" },
          near.map((x) =>
            h(
              "li",
              null,
              h(
                "button",
                { class: "row", onclick: () => go({ name: "stop", stop: x.stop }) },
                h("span", { class: "row-icon" }, icon.stop()),
                h("span", { class: "row-main" }, h("span", null, nm(net.stops[x.stop].n)), stopLine(x.stop)),
                h("span", { class: "walk-min" }, icon.walk(), fmtMinutes((x.crow * 1.3) / 1.25)),
                linesAt(x.stop, 3),
              ),
            ),
          ),
        ),
      )
    : null;
  if (state.from && to && dist(state.from.ll, to.ll) < 80)
    return h(
      "div",
      { class: "empty-state" },
      h("span", { class: "row-icon" }, icon.pin()),
      h("p", null, t("samePlace")),
      h("div", { class: "tip-actions" }, h("button", { class: "btn btn-small btn-primary", onclick: () => go({ name: "search", field: "to" }) }, t("changeDest"))),
    );
  if (!state.journeys.length)
    return h(
      "div",
      null,
      h(
        "div",
        { class: "empty-state" },
        h("span", { class: "row-icon" }, icon.bus()),
        h("p", null, t("noTrip")),
        h("div", { class: "tip-actions" }, h("button", { class: "btn btn-small btn-primary", onclick: () => go({ name: "search", field: "from" }) }, t("changeStart")), h("button", { class: "btn btn-small", onclick: () => go({ name: "lines" }) }, t("seeLines"))),
      ),
      nearBlock,
      dataNote(),
    );
  return h("div", { class: "results" }, to?.sub ? h("p", { class: "muted", style: "margin:2px 0 4px" }, nm(to.sub)) : null, compareBlock(), nearBlock, dataNote());
}

// ---------- comparing every way to get there ----------
// Options are ranked by generalised cost: price plus time, priced at the
// rider's own value of time (the slider), walking and waiting weighted heavier.
function getPrefs(): Prefs {
  let vot = DEFAULT_VOT;
  let avoidWalk = false;
  try {
    const v = Number(localStorage.getItem("vot"));
    if (v >= VOT_RANGE[0] && v <= VOT_RANGE[1]) vot = v;
    avoidWalk = localStorage.getItem("avoidWalk") === "1";
  } catch {}
  return { vot, walkWeight: avoidWalk ? 3 : 1.5 };
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem("vot", p.vot.toFixed(4));
    localStorage.setItem("avoidWalk", p.walkWeight > 2 ? "1" : "0");
  } catch {}
}
const toSlider = (vot: number) => Math.round((100 * Math.log(vot / VOT_RANGE[0])) / Math.log(VOT_RANGE[1] / VOT_RANGE[0]));
const fromSlider = (v: number) => VOT_RANGE[0] * (VOT_RANGE[1] / VOT_RANGE[0]) ** (v / 100);
let showAllOptions = false;
let prefsOpen = false;
function compareBlock() {
  if (!state.from || !state.to) return null;
  const { options, note, night } = buildOptions(net, state.journeys, state.from.ll, state.to.ll, new Date(), walkPace());
  const prefs = getPrefs();
  // Drop options that are worse than another on time, price and walking at once.
  const front = paretoFront(options);
  const hidden = options.length - front.length;
  const win = winners(options);
  const list = h("div", { class: "options" });
  const worth = h("small", { class: "muted pref-worth" });
  const summary = h("span", { class: "pref-summary" });
  const draw = () => {
    const ranked = recommend(showAllOptions ? options : front, prefs);
    const longest = Math.max(...ranked.map((o) => o.range[1]), 1);
    worth.textContent = t("votLabel", Math.round(prefs.vot * 60));
    summary.textContent = t("prefSummary", prefs.vot < 0.07 ? t("prefSave") : prefs.vot > 0.35 ? t("prefTime") : t("prefBalanced"), Math.round(prefs.vot * 60));
    list.replaceChildren(
      ...ranked.map((o, i) =>
        optionRow(
          o,
          i === 0,
          // The top option just says so; the others say what they're best at.
          (i === 0 ? [t("recommended")] : [nearTie(ranked[0], o, prefs) && t("nearTie"), win.fast === o && t("prioFast"), win.cheap === o && t("prioCheap"), win.walk === o && t("prioWalk")]).filter(Boolean) as string[],
          longest,
          i === 0 ? null : tradeText(ranked[0], o),
          () => {
            // Picking something other than the top option teaches the app a little.
            const next = { ...prefs, vot: learnVot(o, options, prefs) };
            savePrefs(next);
          },
        ),
      ),
    );
    const top = ranked[0];
    if (top?.journey !== undefined) previewTrip(top.journey);
  };
  const slider = h("input", {
    type: "range",
    min: 0,
    max: 100,
    value: toSlider(prefs.vot),
    class: "pref-slider",
    "aria-label": t("prefTitle"),
    oninput: (e: Event) => {
      prefs.vot = fromSlider(Number((e.target as HTMLInputElement).value));
      savePrefs(prefs);
      draw();
    },
  });
  const walkToggle = h(
    "button",
    {
      class: `chip-toggle${prefs.walkWeight > 2 ? " on" : ""}`,
      "aria-pressed": prefs.walkWeight > 2 ? "true" : "false",
      onclick: () => {
        prefs.walkWeight = prefs.walkWeight > 2 ? 1.5 : 3;
        savePrefs(prefs);
        walkToggle.classList.toggle("on", prefs.walkWeight > 2);
        walkToggle.setAttribute("aria-pressed", prefs.walkWeight > 2 ? "true" : "false");
        draw();
      },
    },
    h("span", { class: "tick" }, icon.check()),
    icon.walk(),
    t("avoidWalk"),
  );
  draw();
  // Folded by default: the options come first, the knob is one tap away.
  const panel = h("div", { class: "pref-panel", hidden: !prefsOpen }, h("div", { class: "pref-row" }, h("span", { class: "pref-end" }, t("prefSave")), slider, h("span", { class: "pref-end" }, t("prefTime"))), worth);
  const opener = h(
    "button",
    {
      class: "pref-open",
      "aria-label": t("prefTitle"),
      "aria-expanded": prefsOpen ? "true" : "false",
      onclick: () => {
        prefsOpen = !prefsOpen;
        panel.hidden = !prefsOpen;
        opener.setAttribute("aria-expanded", prefsOpen ? "true" : "false");
      },
    },
    summary,
    icon.chevron(),
  );
  return h(
    "div",
    { class: "compare" },
    h("div", { class: "prefs" }, h("div", { class: "pref-row pref-row-2" }, opener, walkToggle), panel),
    night ? h("p", { class: "tip tip-night" }, icon.clock(), h("small", null, t("nightNote"))) : null,
    h(
      "p",
      { class: "bar-legend", "aria-hidden": "true" },
      h("span", { class: "key key-ride" }),
      t("legendRide"),
      h("span", { class: "key key-walk" }),
      t("legendWalk"),
      h("span", { class: "key key-wait" }),
      t("legendWait"),
    ),
    list,
    hidden > 0
      ? h(
          "button",
          {
            class: "link show-all",
            onclick: () => {
              showAllOptions = !showAllOptions;
              render();
            },
          },
          showAllOptions ? t("hideWorse") : hidden === 1 ? t("showWorseOne") : t("showWorse", hidden),
        )
      : null,
    note ? h("p", { class: "tip" }, h("span", { class: "row-main" }, h("strong", null, t("petitTaxi")), h("small", null, t("petitTaxiOtherTown", note.town)))) : null,
  );
}

/** "2.5 DH less · 10 min more" compared with the recommended option. */
function tradeText(best: Option, o: Option) {
  const { dMin, dDH } = tradeoff(best, o);
  const bits: string[] = [];
  if (dDH !== undefined && dDH !== 0) bits.push(dDH < 0 ? t("tradeCheaper", fmtNum(-dDH)) : t("tradeDearer", fmtNum(dDH)));
  if (Math.abs(dMin) >= 1) bits.push(dMin > 0 ? t("tradeSlower", dMin) : t("tradeFaster", -dMin));
  return bits.length ? bits.join(" · ") : null;
}
const fmtNum = (n: number) => (n % 1 ? n.toFixed(1).replace(".", getLang() === "en" ? "." : ",") : String(n));

function timeBar(o: Option, longest: number, spoken: string) {
  const total = o.parts.reduce((n, p) => n + p.s, 0) || 1;
  const label: Record<Part["k"], Key> = { walk: "legendWalk", wait: "legendWait", ride: "legendRide" };
  // The bar is the likely time; the faint tail reaches the slow end of the range.
  const tail = Math.max(0, o.range[1] - o.seconds);
  return h(
    "div",
    { class: "tbar-track", role: "img", "aria-label": spoken, title: spoken },
    h(
      "div",
      { class: "tbar", style: `width:${Math.max(14, (o.seconds / longest) * 100)}%` },
      o.parts
        .filter((p) => p.s > 20)
        .map((p) => h("span", { class: `seg seg-${p.k}`, style: `flex-grow:${p.s / total};${p.colour ? `--c:${p.colour}` : ""}`, title: `${t(label[p.k])} · ${fmtMinutes(p.s)}` })),
    ),
    tail > 60 ? h("span", { class: "tbar-tail", style: `width:${(tail / longest) * 100}%`, title: t("rangeTitle") }) : null,
  );
}

function breakdown(o: Option) {
  const sum = (k: Part["k"]) => o.parts.filter((p) => p.k === k).reduce((n, p) => n + p.s, 0);
  return [
    sum("walk") > 30 ? t("bdWalk", fmtMinutes(sum("walk"))) : null,
    sum("wait") > 30 ? t("bdWait", fmtMinutes(sum("wait"))) : null,
    sum("ride") > 30 ? t("bdRide", fmtMinutes(sum("ride"))) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function optionRow(o: Option, first: boolean, tags: string[], longest: number, trade: string | null, onChoose: () => void) {
  const j = o.journey !== undefined ? state.journeys[o.journey] : undefined;
  let head: Node;
  let sub: string;
  if (o.kind === "transit" && j) {
    const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
    head = legChips(j);
    sub = `${nm(net.stops[variantOf(rides[0]).stops[rides[0].board]].n)} · ${rides.length > 1 ? `${rides.length - 1} ${rides.length > 2 ? t("changes") : t("change")}` : t("direct")}`;
  } else if (o.kind === "walk") {
    head = h("span", { class: "mode-name" }, icon.walk(), t("walkAll"));
    sub = fmtDistance(o.walkMetres);
  } else {
    head = h("span", { class: "mode-name" }, icon.car(), o.kind === "airportTaxi" ? t("airportTaxi") : t("petitTaxi"));
    sub = o.kind === "airportTaxi" ? t("airportTaxiSub") : `${t("petitTaxiSub")}${o.nightRate ? ` · ${t("petitTaxiNight")}` : ""}`;
  }
  const price = !o.cost
    ? t("fareUnknown")
    : o.cost.high === 0
      ? t("free")
      : o.cost.low === o.cost.high
        ? `≈ ${fmtDH(o.cost.low)}${o.perCar ? ` ${t("perCar")}` : ""}`
        : `≈ ⁦${o.cost.low}–${o.cost.high} DH⁩`;
  const [lo, hi] = o.range.map((x) => Math.max(1, Math.round(x / 60)));
  const body = [
    h(
      "div",
      { class: "opt-top" },
      h("div", { class: "opt-main" }, tags.length ? h("div", { class: "opt-tags" }, tags.map((x) => h("span", { class: "opt-tag" }, x))) : null, head, h("span", { class: "journey-sub" }, sub)),
      h(
        "div",
        { class: "ticket-stub" },
        h("span", { class: "ticket-time" }, String(Math.max(1, Math.round(o.seconds / 60))), h("small", null, t("min"))),
        hi > lo ? h("span", { class: "ticket-range" }, `⁦${lo}–${hi}⁩ ${t("min")}`) : null,
        h("span", { class: "ticket-fare" }, price),
      ),
    ),
    timeBar(o, longest, breakdown(o)),
    trade ? h("p", { class: "opt-trade" }, trade) : null,
  ];
  if (o.journey === undefined) return h("div", { class: `option${first ? " best" : ""}` }, body);
  const ji = o.journey;
  return h(
    "button",
    {
      class: `option${first ? " best" : ""}`,
      onmouseenter: () => previewTrip(ji),
      onfocus: () => previewTrip(ji),
      onclick: () => {
        onChoose();
        go({ name: "trip", index: ji });
      },
    },
    body,
  );
}

function previewTrip(i: number) {
  const j = state.journeys[i];
  if (!j) return;
  bmap?.showTrip(j, state.from?.ll, state.to?.ll, { board: "", alight: t("getOff"), origin: nm(state.from?.label), dest: nm(state.to?.label) });
}

const DIRS = {
  fr: ["le nord", "le nord-est", "l'est", "le sud-est", "le sud", "le sud-ouest", "l'ouest", "le nord-ouest"],
  ar: ["الشمال", "الشمال الشرقي", "الشرق", "الجنوب الشرقي", "الجنوب", "الجنوب الغربي", "الغرب", "الشمال الغربي"],
  en: ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"],
};
function heading(a: LngLat, b: LngLat) {
  const i = Math.round(bearing(a, b) / 45) % 8;
  const lang = getLang();
  return lang === "fr" ? `vers ${DIRS.fr[i]}` : lang === "ar" ? `جهة ${DIRS.ar[i]}` : `head ${DIRS.en[i]}`;
}

function stopLine(stop: number) {
  const s = net.stops[stop];
  const near = s.near !== undefined ? net.places[s.near] : undefined;
  const area = s.area !== undefined ? net.places[s.area] : undefined;
  const bits = [near ? `${t("near")} ${nm(near.n)}` : null, area ? nm(area.n) : null].filter(Boolean);
  return bits.length ? h("small", { class: "muted" }, bits.join(" · ")) : null;
}

// A trip as a vertical route: dotted line for walking, the line's colour for
// riding, a dot at each place you change what you're doing.
function tripBody(index: number) {
  const j = state.journeys[index];
  const steps: Node[] = [];
  const dot = (cls = "") => h("span", { class: `tl-mark ${cls}` });
  const note = (ic: HTMLElement, text: string) => h("p", { class: "tl-note" }, ic, h("span", null, text));
  steps.push(h("li", { class: "tl tl-place" }, dot("tl-start"), h("div", { class: "tl-main" }, h("strong", null, nm(state.from?.label)))));
  j.legs.forEach((leg, i) => {
    if (leg.kind === "walk") {
      const toDest = i === j.legs.length - 1;
      const next = j.legs[i + 1] as RideLeg | undefined;
      const target = toDest ? nm(state.to?.label) : nm(net.stops[variantOf(next!).stops[next!.board]].n);
      steps.push(
        h(
          "li",
          { class: "tl tl-walk" },
          h("span", { class: "tl-mark tl-walk-icon" }, icon.walk()),
          h("div", { class: "tl-main" }, h("span", null, `${toDest ? t("stepArrive") : t("stepWalkTo")} ${target}`), h("small", { class: "muted" }, `${fmtMinutes(leg.seconds)} · ${fmtDistance(leg.metres)} · ${heading(leg.from, leg.to)}`)),
        ),
      );
      return;
    }
    const line = net.lines[leg.line];
    const v = variantOf(leg);
    const c = `--c:${visible(line.colour)}`;
    const boardStop = v.stops[leg.board];
    const alightStop = v.stops[leg.alight];
    const between = v.stops.slice(leg.board + 1, leg.alight);
    const before = leg.alight - 1 > leg.board ? v.stops[leg.alight - 1] : undefined;
    const fare = fareFor(line, v, leg.board, leg.alight);
    const list = h("ol", { class: "mini-stops", hidden: true }, between.map((s) => h("li", null, nm(net.stops[s].n))));
    const toggle = between.length
      ? h(
          "button",
          {
            class: "link",
            onclick: () => {
              list.hidden = !list.hidden;
              toggle!.textContent = list.hidden ? t("showStops") : t("hideStops");
            },
          },
          t("showStops"),
        )
      : null;
    const waitNote = line.taxi ? t("taxiLeaves") : line.headway ? t("noteWait", line.headway) : t("noteWaitUnknown", fmtMinutes(waitFor(line)));
    steps.push(
      h(
        "li",
        { class: "tl tl-stop", style: c },
        dot(),
        h(
          "div",
          { class: "tl-main" },
          h("strong", { class: "tl-stop-name" }, nm(net.stops[boardStop].n)),
          stopLine(boardStop),
          h("div", { class: "tl-board" }, `${line.taxi ? t("takeTaxi") : t("stepTake")} `, lineBadge(line.ref, line.colour), ` ${t("towards")} `, h("strong", null, v.to)),
          note(icon.clock(), waitNote),
        ),
      ),
      h(
        "li",
        { class: "tl tl-ride", style: c },
        h("span", { class: "tl-mark" }),
        h(
          "div",
          { class: "tl-main" },
          h("span", null, `${fmtStops(leg.alight - leg.board)} · ${fmtMinutes(leg.seconds)}`),
          fare ? h("small", { class: "muted" }, `${t("fare")} ≈ ${fmtDH(fare.normal)}${line.taxi ? ` ${t("perSeat")}` : ""}${fare.card && fare.card !== fare.normal ? `, ${fmtDH(fare.card)} ${t("withCard")}` : ""}`) : null,
          toggle,
          list,
        ),
      ),
      h(
        "li",
        { class: "tl tl-stop tl-off", style: c },
        dot(),
        h(
          "div",
          { class: "tl-main" },
          h("small", { class: "tl-off-label" }, t("stepGetOff")),
          h("strong", { class: "tl-stop-name" }, nm(net.stops[alightStop].n)),
          stopLine(alightStop),
          before !== undefined ? note(icon.bell(), t("noteGetReady", nm(net.stops[before].n))) : null,
        ),
      ),
    );
  });
  steps.push(h("li", { class: "tl tl-place" }, dot("tl-end"), h("div", { class: "tl-main" }, h("strong", null, nm(state.to?.label)))));
  const fare = journeyFare(j);
  return h(
    "div",
    { class: "trip" },
    header(h("span", { class: "head-legs" }, legChips(j)), null),
    h(
      "div",
      { class: "trip-summary" },
      h("span", { class: "journey-time" }, `≈ ${fmtMinutes(j.seconds)}`),
      h("span", { class: "muted" }, `${fmtDistance(j.walkMetres)} ${t("walkMin")}${fare ? ` · ≈ ${fmtDH(fare)}` : ""}`),
    ),
    h("ol", { class: "timeline" }, steps),
    h("div", { class: "actions" }, h("button", { class: "btn btn-primary", onclick: () => go({ name: "ride", index }) }, icon.arrow(), t("startTrip"))),
    h("p", { class: "fine" }, t("estimates")),
  );
}

function rideBody(index: number) {
  const j = state.journeys[index];
  const box = h("div", { class: "ride" });
  const body = h("div", { class: "ride-body" });
  box.append(body, h("p", { class: "fine" }, t("rideKeepOpen")), h("div", { class: "actions" }, h("button", { class: "btn", onclick: back }, t("stopTrip"))));
  ride = new RideTracker(net, j, (u) => {
    if (u.me) bmap?.setMe(u.me, u.acc);
    if (u.me && u.follow) bmap?.map.easeTo({ center: u.me, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
    const leg = j.legs[u.leg];
    let main: Node;
    if (u.status === "nogps") main = h("p", null, t("noGps"));
    else if (!leg) main = h("div", { class: "sign" }, h("div", { class: "sign-row" }, h("span", { class: "sign-text" }, t("arrive"))));
    else if (leg.kind === "walk") {
      const next = j.legs[u.leg + 1] as RideLeg | undefined;
      main = h(
        "div",
        null,
        h("p", { class: "label" }, next ? t("walkTo") : t("walkToDest")),
        h("p", { class: "ride-big" }, next ? nm(net.stops[variantOf(next).stops[next.board]].n) : nm(state.to?.label)),
        h("p", { class: "muted" }, u.remaining !== undefined ? fmtDistance(u.remaining) : t("locating")),
        next && u.remaining !== undefined && u.remaining < 40
          ? h("div", { class: "sign" }, h("div", { class: "sign-row" }, h("span", { class: "sign-num" }, net.lines[next.line].brt ? "T" : net.lines[next.line].ref), h("span", { class: "sign-text" }, variantOf(next).to)), h("div", { class: "sign-sub" }, t("boardHere")))
          : null,
      );
    } else {
      const line = net.lines[leg.line];
      const v = variantOf(leg);
      const left = u.stopsLeft ?? leg.alight - leg.board;
      const alert = left <= 1;
      main = h(
        "div",
        null,
        h(
          "div",
          { class: "sign" },
          h("div", { class: "sign-row" }, h("span", { class: "sign-num" }, line.brt ? "T" : line.ref), h("span", { class: "sign-text" }, v.to)),
          u.nextStop !== undefined ? h("div", { class: "sign-sub" }, `${t("nextIs")} · ${nm(net.stops[u.nextStop].n)}`) : null,
        ),
        h(
          "div",
          { class: alert ? "ride-alert" : "" },
          alert
            ? h("p", { class: "ride-big" }, left === 0 ? t("getOffNow") : t("getOffNext"))
            : h("p", { class: "ride-big" }, h("span", { class: "num" }, String(left)), h("small", null, t("stopsLeft"))),
          h("p", null, `${t("getOff")} `, h("strong", { class: "marked" }, nm(net.stops[v.stops[leg.alight]].n))),
        ),
      );
    }
    body.replaceChildren(main);
  });
  ride.start();
  return box;
}

function linesBody() {
  return h(
    "div",
    { class: "lines" },
    header(t("allLines"), `${net.lines.length} ${t("lines").toLowerCase()}`),
    h(
      "ul",
      { class: "list" },
      net.lines.map((l, li) => {
        const v = l.variants[0];
        const routable = l.variants.some((x) => x.stops.length >= 2);
        const fare = l.fare?.kind === "flat" ? fmtDH(l.fare.normal) : undefined;
        return h(
          "li",
          null,
          h(
            "button",
            { class: "row", onclick: () => go({ name: "line", line: li, variant: 0 }) },
            lineBadge(l.ref, l.colour),
            h("span", { class: "row-main" }, h("span", null, `${v.from} – ${v.to}`), !routable ? h("small", { class: "muted" }, t("pathOnly")) : fare ? h("small", { class: "muted" }, fare) : null),
            icon.chevron(),
          ),
        );
      }),
    ),
  );
}

function lineBody(li: number, vi: number) {
  const l = net.lines[li];
  const v = l.variants[vi];
  const dirs =
    l.variants.length > 1
      ? h(
          "div",
          { class: "segmented", role: "tablist" },
          l.variants.map((x, i) =>
            h(
              "button",
              {
                class: i === vi ? "on" : "",
                role: "tab",
                "aria-selected": i === vi ? "true" : "false",
                onclick: () => {
                  state.stack[state.stack.length - 1] = { name: "line", line: li, variant: i };
                  render();
                },
              },
              `→ ${x.to}`,
            ),
          ),
        )
      : null;
  const facts = [fmtStops(v.stops.length), fmtDistance(v.length), l.headway ? t("noteWait", l.headway) : null, l.fare?.kind === "flat" ? fmtDH(l.fare.normal) : null].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: "line" },
    header(h("span", { class: "head-line" }, lineBadge(l.ref, l.colour, "lg"), h("span", null, `${v.from} – ${v.to}`)), facts),
    dirs,
    v.inferred ? h("p", { class: "fine", style: "margin:0 0 8px" }, t("orderInferred")) : null,
    v.stops.length < 2
      ? h("p", { class: "notice" }, t("pathOnly"))
      : h(
          "ol",
          { class: "line-stops" },
          v.stops.map((s) => h("li", null, h("button", { class: "row", onclick: () => go({ name: "stop", stop: s }) }, h("span", { class: "row-main" }, h("span", null, nm(net.stops[s].n)), stopLine(s))))),
        ),
  );
}

function stopBody(si: number) {
  const s = net.stops[si];
  const serving: { li: number; vi: number }[] = [];
  net.lines.forEach((l, li) => l.variants.forEach((v, vi) => v.stops.includes(si) && serving.push({ li, vi })));
  return h(
    "div",
    { class: "stop" },
    header(nm(s.n) || t("stop"), stopLine(si)),
    endpointButtons({ ll: s.ll, label: s.n, kind: "stop" }),
    h("h3", { class: "section-title label" }, t("linesHere")),
    h(
      "ul",
      { class: "list" },
      serving.map(({ li, vi }) => {
        const l = net.lines[li];
        const v = l.variants[vi];
        return h("li", null, h("button", { class: "row", onclick: () => go({ name: "line", line: li, variant: vi }) }, lineBadge(l.ref, l.colour), h("span", { class: "row-main" }, h("span", null, `${t("towards")} ${v.to}`)), icon.chevron()));
      }),
    ),
  );
}

function endpointButtons(ep: Endpoint) {
  return h(
    "div",
    { class: "actions two" },
    h("button", { class: "btn", onclick: () => setEndpoint("from", ep) }, h("span", { class: "dot dot-from" }), t("fromHere")),
    h("button", { class: "btn btn-primary", onclick: () => setEndpoint("to", ep) }, h("span", { class: "dot dot-to" }), t("toHere")),
  );
}

function pointBody(ll: LngLat) {
  const near = router.stopsNear(ll, 700);
  const seen = new Set<string>();
  const list = near.filter((x) => {
    const k = net.stops[x.stop].n.d ?? String(x.stop);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 3);
  return h(
    "div",
    { class: "point" },
    header(t("pointOnMap"), list[0] ? `${t("near")} ${nm(net.stops[list[0].stop].n)}` : null),
    endpointButtons({ ll, label: { d: t("pointOnMap") }, kind: "map" }),
    list.length
      ? h(
          "ul",
          { class: "list stop-near" },
          list.map((x) => h("li", null, h("button", { class: "row", onclick: () => go({ name: "stop", stop: x.stop }) }, h("span", { class: "row-icon" }, icon.stop()), h("span", { class: "row-main" }, h("span", null, nm(net.stops[x.stop].n))), h("span", { class: "walk-min" }, icon.walk(), fmtMinutes((x.crow * 1.3) / 1.25)), linesAt(x.stop, 3)))),
        )
      : null,
  );
}

function segmented<T extends string>(options: { id: T; label: string; lang?: string }[], currentId: T, pick: (id: T) => void) {
  return h(
    "div",
    { class: "segmented" },
    options.map((o) => h("button", { class: o.id === currentId ? "on" : "", lang: o.lang, "aria-pressed": o.id === currentId ? "true" : "false", onclick: () => pick(o.id) }, o.label)),
  );
}

function installBlock() {
  if (standalone()) return h("p", { class: "notice" }, icon.check(), " ", t("installed"));
  return h(
    "div",
    { class: "install-steps" },
    installEvent ? h("button", { class: "btn btn-primary", onclick: install }, icon.offline(), t("installNow")) : h("p", null, isIos ? t("helpInstallIos") : t("helpInstallAndroid")),
    offlineMB ? h("small", { class: "muted" }, t("offlineSize", offlineMB)) : null,
  );
}

function aboutBody() {
  return h(
    "div",
    { class: "about" },
    header(t("settings")),
    h("h3", { class: "section-title label" }, t("language")),
    segmented(
      LANGS.map((l) => ({ id: l.id, label: l.label, lang: l.id === "ar" ? "ar-MA" : l.id })),
      getLang(),
      (id) => {
        setLang(id as Lang);
        bmap?.setLang(id);
        render();
      },
    ),
    h("h3", { class: "section-title label" }, t("appearance")),
    segmented<Theme>(
      [
        { id: "auto", label: t("themeAuto") },
        { id: "light", label: t("themeLight") },
        { id: "dark", label: t("themeDark") },
      ],
      getTheme(),
      (id) => {
        setTheme(id);
        render();
      },
    ),
    h("h3", { class: "section-title label" }, t("helpOfflineTitle")),
    h("p", { class: "notice" }, offline.total && offline.done >= offline.total ? [icon.check(), " ", t("offlineReady")] : offline.total ? `${t("downloading")} · ${Math.floor((offline.done / offline.total) * 100)} %` : t("helpOffline")),
    h("h3", { class: "section-title label" }, t("helpInstallTitle")),
    installBlock(),
    h("button", { class: "cta", onclick: () => go({ name: "help" }) }, h("span", { class: "plus" }, "?"), t("helpLink")),
    h("p", null, t("aboutText")),
    dataNote(),
    h("p", { class: "fine" }, [t("dataAlsa"), t("dataAmalway"), t("dataOverture")].join(" · ")),
    h(
      "p",
      { class: "fine" },
      h("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" }, "© OpenStreetMap contributors"),
      " · ",
      h("a", { href: "https://docs.overturemaps.org/attribution/", target: "_blank", rel: "noopener" }, "Overture Maps Foundation"),
      " · ",
      h("a", { href: "https://protomaps.com", target: "_blank", rel: "noopener" }, "Protomaps"),
      " · ",
      h("a", { href: "https://github.com/zkousama/tobis", target: "_blank", rel: "noopener" }, "GitHub"),
    ),
  );
}

/** What the app does, what it doesn't, and how to get round the gaps. */
function helpBody(section?: string) {
  const sec = (id: string, title: string, ...body: Node[]) => h("section", { class: "help-section", id: `help-${id}` }, h("h3", { class: "step-title" }, title), ...body);
  const list = (keys: Parameters<typeof t>[0][], cls = "help-list") => h("ul", { class: cls }, keys.map((k) => h("li", null, t(k))));
  const el = h(
    "div",
    { class: "help" },
    header(t("help")),
    sec("what", t("helpWhatTitle"), list(["helpWhat1", "helpWhat2", "helpWhat3", "helpWhat4"])),
    sec("cant", t("helpCantTitle"), list(["helpCant1", "helpCant2", "helpCant3", "helpCant4"], "help-list help-cant")),
    sec(
      "find",
      t("helpFindTitle"),
      h("ol", { class: "help-steps" }, (["helpFind1", "helpFind2", "helpFind3", "helpFind4"] as const).map((k) => h("li", null, t(k)))),
      h("p", { class: "tl-note" }, icon.info(), h("span", null, t("helpFindNote"))),
      h("button", { class: "btn btn-small", onclick: () => pasteFromClipboard("to") }, icon.link(), t("pasteLink")),
    ),
    sec("install", t("helpInstallTitle"), installBlock()),
    sec("offline", t("helpOfflineTitle"), h("p", null, t("helpOffline"))),
    sec("location", t("helpLocTitle"), h("p", null, t("helpLoc"))),
  );
  if (section) queueMicrotask(() => el.querySelector(`#help-${section}`)?.scrollIntoView({ block: "start" }));
  return el;
}

// ---------- shareable links: #from=lon,lat&to=lon,lat ----------
function writeHash() {
  if (!state.from || !state.to) return;
  const enc = (e: Endpoint) => `${e.ll[0].toFixed(5)},${e.ll[1].toFixed(5)}${e.kind !== "map" && e.kind !== "me" ? `,${encodeURIComponent(nm(e.label))}` : ""}`;
  const hash = `#from=${enc(state.from)}&to=${enc(state.to)}`;
  history.replaceState(null, "", hash);
  try {
    localStorage.setItem("lastTrip", JSON.stringify({ hash, at: Date.now() }));
  } catch {}
}
const LAST_TRIP_MS = 2 * 3600 * 1000;
function lastTripHash() {
  try {
    const j = JSON.parse(localStorage.getItem("lastTrip") ?? "null");
    if (j && Date.now() - j.at < LAST_TRIP_MS) return String(j.hash);
  } catch {}
  return "";
}
function restoreFromHash() {
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

// ---------- bottom sheet drag ----------
{
  let startY = 0;
  let startH = 0;
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = sheet.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    sheet.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    sheet.style.height = `${Math.max(90, Math.min(innerHeight * 0.92, startH + (startY - e.clientY)))}px`;
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("dragging");
    const moved = startY - e.clientY;
    const hgt = sheet.getBoundingClientRect().height / innerHeight;
    sheet.style.height = "";
    if (Math.abs(moved) < 6) setSheet(state.sheet === "peek" ? "half" : state.sheet === "half" ? "full" : "peek");
    else setSheet(hgt > 0.7 ? "full" : hgt > 0.3 ? "half" : "peek");
    if (state.sheet === "full") userOpenedSheet();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.stack.length > 1) back();
});

boot().catch((err) => {
  console.error(err);
  sheetBody.replaceChildren(h("p", { class: "notice" }, String(err)));
});
