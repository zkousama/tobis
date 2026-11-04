import "./style.css";
import type { BusMap } from "./map.ts";
import { Router, waitFor, type Journey, type RideLeg, type WalkFn } from "./router.ts";
import { SearchIndex, type Hit } from "./search.ts";
import { nameOf, type Names, type Network } from "./network.ts";
import { bearing, dist, type LngLat } from "./geo.ts";
import { detectLang, fmtDistance, fmtMinutes, fmtStops, getLang, LANGS, setLang, t, typeLabel, type Lang } from "./i18n.ts";
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
const handle = h("button", { class: "sheet-handle", "aria-label": "Resize" });
const sheet = h("section", { class: "sheet", "data-size": state.sheet }, handle, sheetBody);
// The map gets the screen: one settings button, no title bar.
const settingsBtn = h("button", { class: "icon-btn map-btn", "aria-label": t("settings"), onclick: () => go({ name: "about" }) }, icon.menu());
const topbar = h("header", { class: "topbar" }, settingsBtn);
// While the offline copy downloads: a thin bar along the top of the sheet.
const progressBar = h("div", { class: "sheet-progress", hidden: true, role: "progressbar", "aria-label": t("downloading") });
sheet.prepend(progressBar);
const locateBtn = h("button", { class: "fab fab-locate", "aria-label": t("myLocation"), onclick: () => locate(true) }, icon.locate());
const toast = h("div", { class: "toast", role: "status" });
app.append(mapEl, topbar, locateBtn, sheet, toast);

let net: Network;
let router: Router;
let searchIndex: SearchIndex | undefined;
let bmap: BusMap | undefined;
// Built when the phone is idle, or on first use, whichever comes first.
const search = () => (searchIndex ??= new SearchIndex(net));
let ride: RideTracker | undefined;

const nm = (n: Names | string | undefined) => (typeof n === "string" ? n : n ? nameOf(n, getLang()) : "");
const meEndpoint = (ll: LngLat): Endpoint => ({ ll, label: { d: t("myLocation") }, kind: "me" });

async function boot() {
  sheetBody.replaceChildren(h("div", { class: "loading" }, h("div", { class: "spinner" })));
  performance.mark("boot");
  const res = await fetch(`${base}data/${CITY}.json`);
  performance.mark("fetched");
  net = await res.json();
  performance.mark("parsed");
  router = new Router(net); // straight-line walking until the street graph is in
  performance.mark("router");
  render(); // the planner is usable before the map has drawn
  performance.mark("rendered");
  watchLocationPermission();
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
function flash(msg: string, ms = 3200) {
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
      enterkeyhint: "search",
      onfocus: () => {
        const cur = current();
        if (cur.name !== "search" || cur.field !== which) go({ name: "search", field: which });
      },
      oninput: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        clear.hidden = !v;
        updateSearch(which, v);
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
    return h("label", { class: `field field-${which}${isActive ? " active" : ""}` }, h("span", { class: `dot dot-${which}` }), input, meDot, clear);
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
  if (canInstall() && !dismissed)
    cards.push(
      h(
        "div",
        { class: "tip tip-install" },
        h("span", { class: "row-icon" }, icon.offline()),
        h("span", { class: "row-main" }, h("strong", null, t("installCard"))),
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
  return h(
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
  searchList.replaceChildren(...hits.map((hit) => h("li", null, hitRow(hit, field, near))));
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
  if (!state.journeys.length)
    return h("div", null, h("div", { class: "empty-state" }, h("span", { class: "row-icon" }, icon.bus()), h("p", null, t("noTrip"))), nearBlock, dataNote());
  return h(
    "div",
    { class: "results" },
    to?.sub ? h("p", { class: "muted", style: "margin:2px 0 4px" }, nm(to.sub)) : null,
    state.journeys.map((j, i) => {
      const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
      const first = rides[0];
      const walkFirst = j.legs[0]?.kind === "walk" ? j.legs[0].seconds : 0;
      const summary = first
        ? `${nm(net.stops[variantOf(first).stops[first.board]].n)} · ${fmtMinutes(walkFirst)} ${t("walkMin")}`
        : `${t("walkAll")} · ${fmtDistance(j.walkMetres)}`;
      const fare = journeyFare(j);
      return h(
        "button",
        {
          class: `ticket${i === 0 ? " best" : ""}`,
          onmouseenter: () => previewTrip(i),
          onfocus: () => previewTrip(i),
          onclick: () => go({ name: "trip", index: i }),
        },
        h(
          "div",
          { class: "ticket-main" },
          i === 0 ? h("span", { class: "label best-label" }, t("best")) : null,
          legChips(j),
          h("div", { class: "journey-sub" }, summary, rides.length > 1 ? ` · ${rides.length - 1} ${rides.length > 2 ? t("changes") : t("change")}` : rides.length === 1 ? ` · ${t("direct")}` : ""),
        ),
        h("div", { class: "ticket-stub" }, h("span", { class: "ticket-time" }, String(Math.max(1, Math.round(j.seconds / 60))), h("small", null, t("min"))), fare ? h("span", { class: "ticket-fare" }, `≈ ${fmtDH(fare)}`) : null),
      );
    }),
    petitTaxiBlock(),
    nearBlock,
    dataNote(),
  );
}

/** Petit taxi as a rough alternative: drive time and a meter estimate. */
function petitTaxiBlock() {
  const pt = net.petitTaxi;
  if (!pt || !state.from || !state.to) return null;
  const crow = dist(state.from.ll, state.to.ll);
  if (crow < 1500) return null; // short enough to walk
  const km = (crow * 1.35) / 1000; // streets are longer than a straight line
  const minutes = (km / 22) * 60 + 4; // ~22 km/h across town, plus a few minutes to find one
  const low = Math.round((pt.start + pt.perKm * km * 0.8) / 5) * 5;
  const high = Math.round((pt.start + pt.perKm * km * 1.2) / 5) * 5;
  return h(
    "div",
    { class: "section" },
    h("h3", { class: "section-title label" }, t("otherWays")),
    h(
      "div",
      { class: "ticket ticket-taxi" },
      h("div", { class: "ticket-main" }, h("strong", null, t("petitTaxi")), h("span", { class: "journey-sub" }, t("petitTaxiSub"))),
      h("div", { class: "ticket-stub" }, h("span", { class: "ticket-time" }, String(Math.round(minutes)), h("small", null, t("min"))), h("span", { class: "ticket-fare" }, `≈ ${fmtDH(low)}–${fmtDH(high)}`)),
    ),
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
  box.append(body, h("div", { class: "actions" }, h("button", { class: "btn", onclick: back }, t("stopTrip"))));
  ride = new RideTracker(net, j, (u) => {
    if (u.me) bmap?.setMe(u.me, u.acc);
    if (u.me && u.follow) bmap?.map.easeTo({ center: u.me, duration: 500 });
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
    installEvent ? h("button", { class: "btn btn-primary", onclick: install }, icon.offline(), t("installNow")) : null,
    h("ol", { class: "help-steps" }, isIos ? h("li", null, t("helpInstallIos")) : [h("li", null, t("helpInstallAndroid")), h("li", null, t("helpInstallIos"))]),
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
  history.replaceState(null, "", `#from=${enc(state.from)}&to=${enc(state.to)}`);
}
function restoreFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
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
