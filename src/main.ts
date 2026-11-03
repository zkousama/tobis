import "@fontsource-variable/rubik/wght.css";
import "./style.css";
import { BusMap } from "./map.ts";
import { Router, type Journey, type RideLeg, type WalkFn } from "./router.ts";
import { SearchIndex, type Hit } from "./search.ts";
import { nameOf, type Names, type Network } from "./network.ts";
import { bearing, dist, type LngLat } from "./geo.ts";
import { detectLang, fmtDistance, fmtMinutes, fmtStops, getLang, LANGS, setLang, t, type Lang } from "./i18n.ts";
import { h, icon, lineBadge } from "./ui/dom.ts";
import { RideTracker } from "./ride.ts";
import { loadWalkGraph } from "./walk.ts";
import { registerOffline } from "./offline.ts";

interface Endpoint {
  ll: LngLat;
  label: Names;
  kind: "me" | "place" | "stop" | "map";
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
  | { name: "about" };

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
};

setLang(detectLang());
const app = document.getElementById("app")!;
app.replaceChildren();

const mapEl = h("div", { id: "map" });
const sheetBody = h("div", { class: "sheet-body" });
const handle = h("button", { class: "sheet-handle", "aria-label": "Resize" });
const sheet = h("section", { class: "sheet", "data-size": state.sheet }, handle, sheetBody);
const offlineChip = h("button", { class: "chip chip-offline", hidden: true });
const topbar = h(
  "header",
  { class: "topbar" },
  h("button", { class: "brand", onclick: () => go({ name: "home" }, true) }, h("span", { class: "brand-mark" }, icon.bus()), h("span", { class: "brand-name" }, t("appName"))),
  h("div", { class: "topbar-actions" }, offlineChip, h("button", { class: "icon-btn", "aria-label": t("about"), onclick: () => go({ name: "about" }) }, icon.menu())),
);
const locateBtn = h("button", { class: "fab fab-locate", "aria-label": t("myLocation"), onclick: () => locate(true) }, icon.locate());
const toast = h("div", { class: "toast", role: "status" });
app.append(mapEl, topbar, locateBtn, sheet, toast);

let net: Network;
let router: Router;
let search: SearchIndex;
let bmap: BusMap;
let ride: RideTracker | undefined;

const nm = (n: Names | undefined) => (n ? nameOf(n, getLang()) : "");

async function boot() {
  sheetBody.replaceChildren(h("div", { class: "loading" }, h("div", { class: "spinner" })));
  const res = await fetch(`${base}data/${CITY}.json`);
  net = await res.json();
  let walk: WalkFn | undefined;
  try {
    walk = await loadWalkGraph(`${base}data/${CITY}-walk.bin`);
  } catch {
    walk = undefined; // straight-line estimates
  }
  router = new Router(net, walk);
  search = new SearchIndex(net);
  bmap = new BusMap(mapEl, net, getLang(), {
    onStop: (s) => go({ name: "stop", stop: s }),
    onLine: (l) => go({ name: "line", line: l, variant: 0 }),
    onPoint: (ll) => {
      if (state.pickOnMap) {
        setEndpoint(state.pickOnMap, { ll, label: { d: t("pointOnMap") }, kind: "map" });
        state.pickOnMap = undefined;
        return;
      }
      go({ name: "point", ll });
    },
  });
  await bmap.ready;
  render();
  registerOffline(offlineChip, t);
  restoreFromHash();
}

// ---------- navigation ----------
function current(): View {
  return state.stack[state.stack.length - 1];
}
function go(v: View, reset = false) {
  if (reset) state.stack = [{ name: "home" }];
  if (v.name !== "home" || !reset) state.stack.push(v);
  if (reset && v.name === "home") state.stack = [{ name: "home" }];
  render();
}
function back() {
  if (state.stack.length > 1) state.stack.pop();
  render();
}
function setSheet(size: "peek" | "half" | "full") {
  state.sheet = size;
  sheet.dataset.size = size;
}

// ---------- endpoints and planning ----------
function setEndpoint(field: "from" | "to", ep: Endpoint) {
  state[field] = ep;
  if (field === "to" && ep.kind !== "me") remember(ep);
  if (!state.from && state.to) {
    // Default the start to the current position when we have one.
    if (state.me) state.from = { ll: state.me.ll, label: { d: t("myLocation") }, kind: "me" };
  }
  if (state.from && state.to) plan();
  else {
    state.stack = [{ name: "home" }];
    if (!state.from) {
      go({ name: "search", field: "from" });
      return;
    }
    render();
  }
}

function plan() {
  if (!state.from || !state.to) return;
  state.journeys = router.plan(state.from.ll, state.to.ll);
  state.stack = [{ name: "home" }, { name: "results" }];
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
    const next = [ep, ...list.filter((e) => nm(e.label) !== nm(ep.label))].slice(0, 6);
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
function locate(fly: boolean): Promise<LngLat | undefined> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return (flash(t("noGps")), resolve(undefined));
    if (fly) flash(t("locating"));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const ll: LngLat = [p.coords.longitude, p.coords.latitude];
        state.me = { ll, acc: p.coords.accuracy, at: Date.now() };
        bmap.setMe(ll, p.coords.accuracy);
        if (fly) bmap.flyTo(ll, 16);
        toast.classList.remove("show");
        resolve(ll);
      },
      () => (flash(t("noGps")), resolve(undefined)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

let toastTimer = 0;
function flash(msg: string, ms = 3000) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), ms);
}

// ---------- rendering ----------
function render() {
  const v = current();
  document.title = t("appName");
  sheetBody.replaceChildren();
  sheet.className = `sheet view-${v.name}`;
  ride?.stop();
  ride = undefined;
  if (v.name !== "trip" && v.name !== "results" && v.name !== "ride") bmap.clearTrip();
  if (v.name !== "line") bmap.clearFocus();
  bmap.showNetwork(v.name === "home" || v.name === "lines" || v.name === "stop" || v.name === "point" || v.name === "search");
  switch (v.name) {
    case "home":
      setSheet(state.sheet === "full" ? "half" : state.sheet);
      sheetBody.append(planner(), homeBody());
      bmap.setPins(state.from?.ll, state.to?.ll);
      break;
    case "search":
      setSheet("full");
      sheetBody.append(planner(v.field), searchBody(v.field));
      break;
    case "results":
      setSheet("half");
      sheetBody.append(planner(), resultsBody());
      if (state.journeys[0]) previewTrip(0);
      else bmap.setPins(state.from?.ll, state.to?.ll);
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
      bmap.showLine(v.line, v.variant);
      break;
    case "stop":
      setSheet("half");
      sheetBody.append(stopBody(v.stop));
      bmap.flyTo(net.stops[v.stop].ll, Math.max(bmap.map.getZoom(), 16));
      break;
    case "point":
      setSheet("peek");
      sheetBody.append(pointBody(v.ll));
      bmap.setPins(undefined, v.ll);
      break;
    case "about":
      setSheet("full");
      sheetBody.append(aboutBody());
      break;
  }
}

function header(title: Node | string, sub?: Node | string) {
  return h(
    "div",
    { class: "view-head" },
    h("button", { class: "icon-btn", "aria-label": t("back"), onclick: back }, icon.back()),
    h("div", { class: "view-title" }, h("h2", null, title), sub ? h("p", { class: "muted" }, sub) : null),
  );
}

function planner(active?: "from" | "to") {
  const field = (which: "from" | "to") => {
    const ep = state[which];
    const isActive = active === which;
    const input = h("input", {
      class: "field-input",
      type: "search",
      placeholder: which === "to" ? t("whereTo") : t("from"),
      value: isActive ? "" : nm(ep?.label),
      "aria-label": which === "to" ? t("to") : t("from"),
      autocomplete: "off",
      enterkeyhint: "search",
      onfocus: () => {
        if (current().name !== "search" || (current() as { field: string }).field !== which) go({ name: "search", field: which });
      },
      oninput: (e: Event) => updateSearch(which, (e.target as HTMLInputElement).value),
    });
    if (isActive) queueMicrotask(() => input.focus());
    return h("label", { class: `field field-${which}${isActive ? " active" : ""}` }, h("span", { class: `dot dot-${which}` }), input);
  };
  return h(
    "div",
    { class: "planner" },
    h("div", { class: "fields" }, field("from"), field("to")),
    h("button", { class: "icon-btn swap", "aria-label": t("swap"), onclick: swap }, icon.swap()),
  );
}

function homeBody() {
  const rec = recents();
  const brt = net.lines.findIndex((l) => l.brt);
  return h(
    "div",
    { class: "home" },
    h(
      "div",
      { class: "quick" },
      brt >= 0
        ? h("button", { class: "quick-card quick-brt", onclick: () => go({ name: "line", line: brt, variant: 0 }) }, lineBadge("BHNS", net.lines[brt].colour), h("span", null, `${net.lines[brt].variants[0].from} – ${net.lines[brt].variants[0].to}`))
        : null,
      h("button", { class: "quick-card", onclick: () => go({ name: "lines" }) }, h("span", { class: "quick-icon" }, icon.bus()), h("span", null, t("allLines"))),
    ),
    rec.length
      ? h(
          "div",
          { class: "section" },
          h("h3", { class: "section-title" }, t("recent")),
          h(
            "ul",
            { class: "list" },
            rec.map((ep) =>
              h(
                "li",
                null,
                h("button", { class: "row", onclick: () => setEndpoint("to", ep) }, h("span", { class: "row-icon" }, icon.clock()), h("span", { class: "row-main" }, nm(ep.label))),
              ),
            ),
          ),
        )
      : null,
    dataNote(),
  );
}

function dataNote() {
  const d = net.osmTimestamp ? new Date(net.osmTimestamp) : undefined;
  return h("p", { class: "fine" }, `${t("dataFrom")} ${d ? d.toLocaleDateString(getLang() === "ar" ? "ar-MA" : getLang()) : "?"}. ${t("estimates")}`);
}

let searchList: HTMLElement | undefined;
function searchBody(field: "from" | "to") {
  searchList = h("ul", { class: "list results-list" });
  const box = h(
    "div",
    { class: "search" },
    h(
      "div",
      { class: "search-actions" },
      h(
        "button",
        {
          class: "row",
          onclick: async () => {
            const ll = state.me?.ll ?? (await locate(false));
            if (ll) setEndpoint(field, { ll, label: { d: t("myLocation") }, kind: "me" });
          },
        },
        h("span", { class: "row-icon accent" }, icon.locate()),
        h("span", { class: "row-main" }, t("myLocation")),
      ),
      h(
        "button",
        {
          class: "row",
          onclick: () => {
            state.pickOnMap = field;
            state.stack = [{ name: "home" }];
            setSheet("peek");
            render();
            setSheet("peek");
            flash(t("tapMap"), 5000);
          },
        },
        h("span", { class: "row-icon" }, icon.pin()),
        h("span", { class: "row-main" }, t("pointOnMap")),
      ),
    ),
    searchList,
    h("p", { class: "fine" }, t("searchHint")),
  );
  return box;
}

function updateSearch(field: "from" | "to", q: string) {
  if (!searchList) return;
  const hits = search.search(q, state.me?.ll ?? net.center);
  searchList.replaceChildren(
    ...(q.trim() && !hits.length ? [h("li", { class: "empty" }, t("noMatch"))] : []),
    ...hits.map((hit) => h("li", null, hitRow(hit, field))),
  );
}

function hitRow(hit: Hit, field: "from" | "to") {
  if (hit.kind === "line") {
    const l = net.lines[hit.index];
    return h("button", { class: "row", onclick: () => go({ name: "line", line: hit.index, variant: 0 }) }, lineBadge(l.ref, l.colour, "sm"), h("span", { class: "row-main" }, h("span", null, nm(hit.sub))));
  }
  const ic = hit.kind === "stop" ? icon.stop() : icon.place();
  return h(
    "button",
    { class: "row", onclick: () => setEndpoint(field, { ll: hit.ll!, label: hit.label, kind: hit.kind === "stop" ? "stop" : "place" }) },
    h("span", { class: "row-icon" }, ic),
    h("span", { class: "row-main" }, h("span", null, nm(hit.label)), hit.sub ? h("small", { class: "muted" }, nm(hit.sub)) : null),
    hit.kind === "stop" ? linesAt(hit.index, 4) : null,
  );
}

function linesAt(stop: number, max = 99) {
  const refs = new Map<number, string>();
  net.lines.forEach((l, li) => l.variants.forEach((v) => v.stops.includes(stop) && refs.set(li, l.ref)));
  // Stops with the same name nearby (other direction) count too.
  const s = net.stops[stop];
  net.stops.forEach((o, oi) => {
    if (oi !== stop && o.n.d === s.n.d && dist(o.ll, s.ll) < 120) net.lines.forEach((l, li) => l.variants.forEach((v) => v.stops.includes(oi) && refs.set(li, l.ref)));
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

function resultsBody() {
  if (!state.journeys.length) return h("div", { class: "empty-state" }, h("p", null, t("noTrip")), dataNote());
  return h(
    "div",
    { class: "results" },
    h(
      "ul",
      { class: "list journeys" },
      state.journeys.map((j, i) => {
        const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
        const first = rides[0];
        const summary = first
          ? `${t("board")} ${net.lines[first.line].ref === "BHNS" ? t("brt") : net.lines[first.line].ref} · ${nm(net.stops[variantOf(first).stops[first.board]].n)}`
          : `${t("walkAll")} · ${fmtDistance(j.walkMetres)}`;
        return h(
          "li",
          null,
          h(
            "button",
            {
              class: "journey",
              onmouseenter: () => previewTrip(i),
              onfocus: () => previewTrip(i),
              onclick: () => go({ name: "trip", index: i }),
            },
            h("div", { class: "journey-top" }, legChips(j), h("span", { class: "journey-time" }, `≈ ${fmtMinutes(j.seconds)}`)),
            h(
              "div",
              { class: "journey-sub muted" },
              summary,
              rides.length > 1 ? ` · ${rides.length - 1} ${rides.length > 2 ? t("changes") : t("change")}` : rides.length === 1 ? ` · ${t("direct")}` : "",
            ),
          ),
        );
      }),
    ),
    dataNote(),
  );
}

const variantOf = (l: RideLeg) => net.lines[l.line].variants[l.variant];

function previewTrip(i: number) {
  const j = state.journeys[i];
  if (!j) return;
  bmap.showTrip(j, state.from?.ll, state.to?.ll, { board: "", alight: t("getOff"), origin: nm(state.from?.label), dest: nm(state.to?.label) });
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

function tripBody(index: number) {
  const j = state.journeys[index];
  const steps: Node[] = [];
  steps.push(h("li", { class: "step step-origin" }, h("span", { class: "step-dot" }), h("div", { class: "step-main" }, h("strong", null, nm(state.from?.label)))));
  j.legs.forEach((leg, i) => {
    if (leg.kind === "walk") {
      const toDest = i === j.legs.length - 1;
      const next = j.legs[i + 1] as RideLeg | undefined;
      const target = toDest ? t("walkToDest") : `${t("walkTo")} ${nm(net.stops[variantOf(next!).stops[next!.board]].n)}`;
      steps.push(
        h(
          "li",
          { class: "step step-walk" },
          h("span", { class: "step-icon" }, icon.walk()),
          h("div", { class: "step-main" }, h("span", null, target), h("small", { class: "muted" }, `${fmtDistance(leg.metres)} · ${fmtMinutes(leg.seconds)} · ${heading(leg.from, leg.to)}`)),
        ),
      );
      return;
    }
    const line = net.lines[leg.line];
    const v = variantOf(leg);
    const boardStop = v.stops[leg.board];
    const alightStop = v.stops[leg.alight];
    const between = v.stops.slice(leg.board + 1, leg.alight);
    const before = leg.alight - 1 > leg.board ? v.stops[leg.alight - 1] : undefined;
    const list = h("ol", { class: "mini-stops", hidden: true }, between.map((s) => h("li", null, nm(net.stops[s].n))));
    const toggle = h("button", { class: "link", onclick: () => ((list.hidden = !list.hidden), (toggle.textContent = list.hidden ? t("showStops") : t("hideStops"))) }, t("showStops"));
    steps.push(
      h(
        "li",
        { class: "step step-board", style: `--c:${line.colour}` },
        h("span", { class: "step-dot" }),
        h(
          "div",
          { class: "step-main" },
          h("strong", null, nm(net.stops[boardStop].n)),
          stopLine(boardStop),
          h("div", { class: "board-line" }, lineBadge(line.ref, line.colour), h("span", null, `${t("towards")} `, h("strong", null, v.to))),
          h("small", { class: "muted" }, `${t("wait")} ${fmtMinutes(leg.wait)}`),
        ),
      ),
      h(
        "li",
        { class: "step step-ride", style: `--c:${line.colour}` },
        h("span", { class: "step-rail" }),
        h("div", { class: "step-main" }, h("span", null, `${fmtStops(leg.alight - leg.board)} · ${fmtMinutes(leg.seconds)} · ${fmtDistance(leg.metres)}`), between.length ? toggle : null, list),
      ),
      h(
        "li",
        { class: "step step-alight", style: `--c:${line.colour}` },
        h("span", { class: "step-dot" }),
        h(
          "div",
          { class: "step-main" },
          h("span", { class: "eyebrow" }, t("getOff")),
          h("strong", null, nm(net.stops[alightStop].n)),
          stopLine(alightStop),
          before !== undefined ? h("small", { class: "muted" }, `${t("getOffAfter")} ${nm(net.stops[before].n)}`) : null,
        ),
      ),
    );
  });
  steps.push(h("li", { class: "step step-dest" }, h("span", { class: "step-dot" }), h("div", { class: "step-main" }, h("strong", null, nm(state.to?.label)))));
  return h(
    "div",
    { class: "trip" },
    header(h("span", { class: "head-legs" }, legChips(j)), `≈ ${fmtMinutes(j.seconds)} · ${fmtDistance(j.walkMetres)} ${t("walk").toLowerCase()}`),
    h("ol", { class: "steps" }, steps),
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
    if (u.me) bmap.setMe(u.me, u.acc);
    if (u.me && u.follow) bmap.map.easeTo({ center: u.me, duration: 500 });
    const leg = j.legs[u.leg];
    let main: Node;
    if (u.status === "nogps") main = h("p", null, t("noGps"));
    else if (!leg) main = h("div", { class: "ride-big" }, icon.flag(), h("strong", null, t("arrive")));
    else if (leg.kind === "walk") {
      const next = j.legs[u.leg + 1] as RideLeg | undefined;
      main = h(
        "div",
        null,
        h("p", { class: "eyebrow" }, next ? t("walkTo") : t("walkToDest")),
        h("p", { class: "ride-big" }, next ? nm(net.stops[variantOf(next).stops[next.board]].n) : nm(state.to?.label)),
        h("p", { class: "muted" }, u.remaining !== undefined ? fmtDistance(u.remaining) : ""),
        next && u.remaining !== undefined && u.remaining < 40
          ? h("div", { class: "ride-line" }, lineBadge(net.lines[next.line].ref, net.lines[next.line].colour, "lg"), h("span", null, `${t("towards")} ${variantOf(next).to}`), h("p", null, t("boardHere")))
          : null,
      );
    } else {
      const line = net.lines[leg.line];
      const v = variantOf(leg);
      const left = u.stopsLeft ?? leg.alight - leg.board;
      const alert = left <= 1;
      main = h(
        "div",
        { class: alert ? "ride-alert" : "" },
        h("div", { class: "ride-line" }, lineBadge(line.ref, line.colour, "lg"), h("span", null, `${t("towards")} ${v.to}`)),
        alert
          ? h("p", { class: "ride-big" }, left === 0 ? t("getOffNow") : t("getOffNext"))
          : h("p", { class: "ride-big" }, h("span", { class: "num" }, String(left)), " ", h("small", null, t("stopsLeft"))),
        h("p", null, `${t("getOff")} `, h("strong", null, nm(net.stops[v.stops[leg.alight]].n))),
        u.nextStop !== undefined ? h("p", { class: "muted" }, `${t("nextStop")} : ${nm(net.stops[u.nextStop].n)}`) : null,
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
    header(t("allLines")),
    h(
      "ul",
      { class: "list" },
      net.lines.map((l, li) => {
        const v = l.variants[0];
        const routable = l.variants.some((x) => x.stops.length >= 2);
        return h(
          "li",
          null,
          h(
            "button",
            { class: "row", onclick: () => go({ name: "line", line: li, variant: 0 }) },
            lineBadge(l.ref, l.colour),
            h("span", { class: "row-main" }, h("span", null, `${v.from} – ${v.to}`), !routable ? h("small", { class: "muted" }, t("pathOnly")) : null),
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
  const dirs = l.variants.length > 1
    ? h(
        "div",
        { class: "segmented", role: "tablist" },
        l.variants.map((x, i) =>
          h("button", { class: i === vi ? "on" : "", role: "tab", "aria-selected": i === vi ? "true" : "false", onclick: () => ((state.stack[state.stack.length - 1] = { name: "line", line: li, variant: i }), render()) }, `→ ${x.to}`),
        ),
      )
    : null;
  return h(
    "div",
    { class: "line" },
    header(h("span", { class: "head-line" }, lineBadge(l.ref, l.colour, "lg"), h("span", null, `${v.from} – ${v.to}`)), `${fmtStops(v.stops.length)} · ${fmtDistance(v.length)}`),
    dirs,
    v.stops.length < 2
      ? h("p", { class: "notice" }, t("pathOnly"))
      : h(
          "ol",
          { class: "line-stops", style: `--c:${l.colour}` },
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
    header(nm(s.n) || t("stop"), stopLine(si) ?? undefined),
    endpointButtons({ ll: s.ll, label: s.n, kind: "stop" }),
    h("h3", { class: "section-title" }, t("linesHere")),
    h(
      "ul",
      { class: "list" },
      serving.map(({ li, vi }) => {
        const l = net.lines[li];
        const v = l.variants[vi];
        return h("li", null, h("button", { class: "row", onclick: () => go({ name: "line", line: li, variant: vi }) }, lineBadge(l.ref, l.colour), h("span", { class: "row-main" }, `${t("towards")} ${v.to}`), icon.chevron()));
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
  const nearest = router.stopsNear(ll, 600)[0];
  return h(
    "div",
    { class: "point" },
    header(t("pointOnMap"), nearest ? `${t("near")} ${nm(net.stops[nearest.stop].n)} (${fmtDistance(nearest.crow)})` : undefined),
    endpointButtons({ ll, label: { d: t("pointOnMap") }, kind: "map" }),
  );
}

function aboutBody() {
  return h(
    "div",
    { class: "about" },
    header(t("about")),
    h("p", null, t("aboutText")),
    h("h3", { class: "section-title" }, t("language")),
    h(
      "div",
      { class: "segmented" },
      LANGS.map((l) =>
        h(
          "button",
          {
            class: l.id === getLang() ? "on" : "",
            lang: l.id === "ar" ? "ar-MA" : l.id,
            onclick: () => {
              setLang(l.id as Lang);
              bmap.setLang(l.id);
              (topbar.querySelector(".brand-name") as HTMLElement).textContent = t("appName");
              render();
            },
          },
          l.label,
        ),
      ),
    ),
    dataNote(),
    h("p", { class: "fine" }, h("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" }, "© OpenStreetMap contributors"), " · ", h("a", { href: "https://protomaps.com", target: "_blank", rel: "noopener" }, "Protomaps")),
  );
}

// ---------- sharable links: #from=lon,lat&to=lon,lat ----------
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
    const hgt = Math.max(90, Math.min(innerHeight * 0.92, startH + (startY - e.clientY)));
    sheet.style.height = `${hgt}px`;
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
