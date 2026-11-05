import "./style.css";
import "./theme.ts"; // applies the saved theme before anything is built, as before
import { Router, type WalkFn } from "./router.ts";
import { getLang, t } from "./i18n.ts";
import { h } from "./ui/dom.ts";
import { loadWalkGraph } from "./walk.ts";
import { registerOffline } from "./offline.ts";
import { walkPace } from "./pace.ts";
import { base, bmap, CITY, current, net, ride, router, search, setAppVersion, setBmap, setNet, setOfflineMB, setRender, setRide, setRouter, state } from "./app/state.ts";
import { handle, locateBtn, mapEl, offlineBanner, onOfflineProgress, settingsBtn, sheet, sheetBody } from "./app/chrome.ts";
import { go, setSheet } from "./app/nav.ts";
import { watchLocationPermission } from "./app/location.ts";
import { clearTripState, handleShare, plan, restoreFromHash, setEndpoint } from "./app/plan.ts";
import { previewTrip } from "./views/common.ts";
import { planner, searchBody } from "./views/search.ts";
import { homeBody } from "./views/home.ts";
import { resultsBody } from "./views/results.ts";
import { pickStopBody } from "./views/tripopts.ts";
import { tripBody } from "./views/trip.ts";
import { rideBody } from "./views/ride.ts";
import { lineBody, linesBody, pointBody, stopBody } from "./views/lines.ts";
import { aboutBody } from "./views/settings.ts";
import { helpBody } from "./views/help.ts";
import "./app/install.ts"; // listens for the browser's install prompt
// The map library is the heaviest part: start fetching it right away, in parallel.
const mapModule = import("./map.ts");

async function boot() {
  sheetBody.replaceChildren(h("div", { class: "loading" }, h("div", { class: "spinner" }), h("p", { class: "muted" }, t("loadingLines"))));
  performance.mark("boot");
  const res = await fetch(`${base}data/${CITY}.json`);
  performance.mark("fetched");
  setNet(await res.json());
  performance.mark("parsed");
  setRouter(new Router(net)); // straight-line walking until the street graph is in
  router.setWalkSpeed(walkPace());
  performance.mark("router");
  render(); // the planner is usable before the map has drawn
  performance.mark("rendered");
  watchLocationPermission();
  fetch(`${base}precache.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { sizes?: number[]; version?: string } | null) => {
      if (j?.sizes) setOfflineMB(Math.round(j.sizes.reduce((a, b) => a + b, 0) / 1048576));
      if (j?.version) setAppVersion(j.version.slice(0, 7));
    })
    .catch(() => {});
  // Say what still works when the signal goes, once each time it happens.
  const signal = () => (offlineBanner.hidden = navigator.onLine);
  addEventListener("offline", signal);
  addEventListener("online", signal);
  signal();
  const { BusMap } = await mapModule;
  setBmap(new BusMap(mapEl, net, getLang(), {
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
  }));
  await bmap!.ready;
  if (state.me) bmap?.setMe(state.me.ll, state.me.acc);
  // Redraw so the screen's map layers appear, except mid-search: that would erase what the rider is typing.
  if (current().name !== "search") render();
  // Switching versions reloads the page: fine while the app is just opening, not mid-search or mid-ride.
  registerOffline(onOfflineProgress, t, () => performance.now() < 15000 && ["home", "results"].includes(current().name));
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
  setRide(undefined);
  if (v.name !== "trip" && v.name !== "results" && v.name !== "ride") bmap?.clearTrip();
  if (v.name !== "line") bmap?.clearFocus();
  bmap?.showNetwork(["home", "lines", "stop", "point", "search"].includes(v.name));
  switch (v.name) {
    case "home":
      // Back on home after a trip: start fresh, as a maps app does.
      if (state.journeys.length) clearTripState();
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
    case "pickStop":
      setSheet("full");
      sheetBody.append(pickStopBody(v.which));
      break;
  }
}
setRender(render);

boot().catch((err) => {
  console.error(err);
  sheetBody.replaceChildren(h("p", { class: "notice" }, String(err)));
});
