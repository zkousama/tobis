import maplibregl, { type GeoJSONSource, type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import { RangeOrWholeSource } from "./tilesource.ts";
import { isDark, onThemeChange } from "./theme.ts";
import { badgeColours, visible } from "./ui/colour.ts";
import { layers, namedFlavor } from "@protomaps/basemaps";
// The package only exports its source entry, so point at the built file directly.
import rtlPluginUrl from "../node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url";
import type { LngLat } from "./geo.ts";
import { sliceLine } from "./geo.ts";
import type { Network } from "./network.ts";
import type { Journey } from "./router.ts";

const base = new URL(import.meta.env.BASE_URL, location.href).href;

// Map colours: Protomaps' neutral base with bluer water; lines in their own colours.
const INK = {
  light: { paper: "#ffffff", ink: "#15191d", net: "#5b6570", casing: "#ffffff", stop: "#ffffff", walk: "#3c444c" },
  dark: { paper: "#111417", ink: "#eceff1", net: "#9aa4ad", casing: "#111417", stop: "#181c20", walk: "#c9d0d6" },
};
function baseFlavor(dark: boolean) {
  const f = namedFlavor(dark ? "dark" : "light");
  return { ...f, water: dark ? "#0f2433" : "#b9d3e6", ocean_label: dark ? "#7fa9c8" : "#3b6f96" };
}
const abs = (p: string) => new URL(p, base).href;

let protocol: Protocol | undefined;
type FC = GeoJSON.FeatureCollection;
const empty = (): FC => ({ type: "FeatureCollection", features: [] });

export interface MapHandlers {
  onStop(stop: number): void;
  onLine(line: number): void;
  onPoint(ll: LngLat): void;
}

// Reduce Motion on: the map jumps instead of flying.
const calm = matchMedia("(prefers-reduced-motion: reduce)");
export const motion = (ms: number) => (calm.matches ? 0 : ms);

export class BusMap {
  readonly map: MLMap;
  private net: Network;
  private markers: maplibregl.Marker[] = [];
  private meMarker?: maplibregl.Marker;
  private dark: boolean;
  private lang: string;
  ready: Promise<void>;

  constructor(el: HTMLElement, net: Network, lang: string, handlers: MapHandlers) {
    this.net = net;
    this.lang = lang;
    this.dark = isDark();
    if (!protocol) {
      protocol = new Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      if (maplibregl.getRTLTextPluginStatus() === "unavailable") maplibregl.setRTLTextPlugin(abs(rtlPluginUrl.replace(/^\//, "")), true);
    }
    protocol.add(new PMTiles(new RangeOrWholeSource(abs(`basemap/${net.city}.pmtiles`))));
    const [w, s, e, n] = net.bbox;
    this.map = new maplibregl.Map({
      container: el,
      style: this.style(),
      center: net.center,
      zoom: net.zoom,
      minZoom: 9,
      maxZoom: 18.5,
      // The offline map covers this box only: panning stops at its edge.
      maxBounds: [
        [w, s],
        [e, n],
      ],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.on("error", (e) => console.error("map:", e.error ?? e));
    this.ready = new Promise((res, rej) =>
      this.map.once("load", () => {
        try {
          this.addOverlays(handlers);
          this.drawKept();
          this.refit();
          // A pan or zoom by the rider (not by us) ends the automatic framing.
          for (const ev of ["dragstart", "zoomstart", "rotatestart"] as const) this.map.on(ev, (e) => e.originalEvent && (this.riderMoved = true));
          this.map.on("resize", () => this.refit());
          this.map.on("moveend", () => this.callouts.length && this.layoutCallouts());
          this.foldCredit();
          // A stop label near the edge slides back inside the map; its pointer stays on the stop.
          this.map.on("move", () => this.keepLabelsInside());
          this.map.on("idle", () => this.keepLabelsInside());
          res();
        } catch (err) {
          rej(err);
        }
      }),
    );
    onThemeChange((dark) => {
      if (dark === this.dark) return;
      this.dark = dark;
      this.restyle();
    });
  }

  private style(): maplibregl.StyleSpecification {
    const flavor = baseFlavor(this.dark);
    return {
      version: 8,
      // Built by hand: URL() would escape the {fontstack}/{range} placeholders.
      glyphs: `${base}basemap/fonts/{fontstack}/{range}.pbf`,
      sprite: abs(`basemap/sprites/${this.dark ? "dark" : "light"}`),
      sources: {
        protomaps: {
          type: "vector",
          url: `pmtiles://${abs(`basemap/${this.net.city}.pmtiles`)}`,
          attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
        },
      },
      layers: layers("protomaps", flavor, { lang: this.lang === "ar" ? "ar" : this.lang }) as maplibregl.LayerSpecification[],
    };
  }

  setLang(lang: string) {
    this.lang = lang;
    this.restyle();
  }

  private handlers?: MapHandlers;
  private lastTrip?: FC;
  private lastAlt?: FC;
  private lastFocus?: FC;
  private restyle() {
    // New base style for the language or theme; then draw our layers again in the new colours.
    this.map.setStyle(this.style(), { diff: false });
    this.map.once("style.load", () => {
      if (!this.handlers) return;
      this.addOverlays(this.handlers, false);
      this.drawKept();
    });
  }
  /** Draw the trip or line asked for before the layers existed. */
  private drawKept() {
    if (this.lastTrip) (this.map.getSource("trip") as GeoJSONSource | undefined)?.setData(this.lastTrip);
    if (this.lastAlt) (this.map.getSource("trip-alt") as GeoJSONSource | undefined)?.setData(this.lastAlt);
    if (this.lastFocus) (this.map.getSource("focus") as GeoJSONSource | undefined)?.setData(this.lastFocus);
  }

  private addOverlays(h: MapHandlers, bind = true) {
    this.handlers = h;
    const m = this.map;
    const P = INK[this.dark ? "dark" : "light"];
    const linesFC: FC = {
      type: "FeatureCollection",
      features: this.net.lines.flatMap((l, li) =>
        l.variants.map((v, vi) => ({
          type: "Feature" as const,
          id: li * 100 + vi,
          properties: { line: li, ref: l.ref, colour: l.colour, brt: l.brt, routable: v.stops.length >= 2 },
          geometry: { type: "LineString" as const, coordinates: v.shape },
        })),
      ),
    };
    const stopsFC: FC = {
      type: "FeatureCollection",
      features: this.net.stops.map((s, i) => ({
        type: "Feature" as const,
        id: i,
        properties: { stop: i, name: s.n.d ?? s.n.fr ?? "" },
        geometry: { type: "Point" as const, coordinates: s.ll },
      })),
    };
    m.addSource("bus-lines", { type: "geojson", data: linesFC });
    m.addSource("bus-stops", { type: "geojson", data: stopsFC });
    m.addSource("trip", { type: "geojson", data: empty() });
    m.addSource("trip-alt", { type: "geojson", data: empty() });
    m.addSource("focus", { type: "geojson", data: empty() });

    m.addLayer({
      id: "bus-lines",
      type: "line",
      source: "bus-lines",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", ["get", "brt"], "#ed6c36", P.net],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "brt"], 2.5, 0.9], 15, ["case", ["get", "brt"], 6, 2.2]],
        "line-opacity": ["case", ["get", "brt"], 0.9, ["get", "routable"], 0.35, 0.15],
      },
    });
    m.addLayer({
      id: "bus-stops",
      type: "circle",
      source: "bus-stops",
      minzoom: 13,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 6],
        "circle-color": P.stop,
        "circle-stroke-color": P.ink,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 17, 2],
      },
    });
    m.addLayer({
      id: "bus-stop-labels",
      type: "symbol",
      source: "bus-stops",
      minzoom: 15.5,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"],
        "text-size": 11,
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: { "text-color": P.ink, "text-halo-color": P.paper, "text-halo-width": 1.6 },
    });
    // Highlighted line (line view).
    m.addLayer({
      id: "focus-casing",
      type: "line",
      source: "focus",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.casing, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 13] },
    });
    m.addLayer({
      id: "focus-line",
      type: "line",
      source: "focus",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "colour"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3.5, 16, 8] },
    });
    m.addLayer({
      id: "focus-stops",
      type: "circle",
      source: "focus",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 7],
        "circle-color": P.stop,
        "circle-stroke-color": ["get", "colour"],
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 3],
      },
    });
    // The other trips on offer, faint and grey under the chosen one, as a maps app shows them:
    // a second stop nearby, and the walk to it, can be seen at a glance.
    m.addLayer({
      id: "trip-alt-walk",
      type: "line",
      source: "trip-alt",
      filter: ["==", ["get", "kind"], "walk"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.walk, "line-opacity": 0.45, "line-width": 3, "line-dasharray": [0, 1.6] },
    });
    m.addLayer({
      id: "trip-alt-ride",
      type: "line",
      source: "trip-alt",
      filter: ["==", ["get", "kind"], "ride"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": this.dark ? "#7d868f" : "#9aa3ab", "line-opacity": 0.6, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] },
    });
    // Planned trip: walking is dotted, riding is the line colour.
    m.addLayer({
      id: "trip-walk",
      type: "line",
      source: "trip",
      filter: ["==", ["get", "kind"], "walk"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.walk, "line-width": 4, "line-dasharray": [0, 1.6] },
    });
    m.addLayer({
      id: "trip-ride-casing",
      type: "line",
      source: "trip",
      filter: ["==", ["get", "kind"], "ride"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.casing, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 16, 14] },
    });
    m.addLayer({
      id: "trip-ride",
      type: "line",
      source: "trip",
      filter: ["==", ["get", "kind"], "ride"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "colour"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 9] },
    });
    m.addLayer({
      id: "trip-stops",
      type: "circle",
      source: "trip",
      filter: ["==", ["get", "kind"], "stop"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 16, 5],
        "circle-color": P.stop,
        "circle-stroke-color": ["get", "colour"],
        "circle-stroke-width": 2,
      },
    });

    if (!bind) return;
    const pick = (e: MapMouseEvent) => {
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - 10, e.point.y - 10],
        [e.point.x + 10, e.point.y + 10],
      ];
      const stop = m.queryRenderedFeatures(box, { layers: ["bus-stops", "focus-stops", "trip-stops"] })[0];
      if (stop?.properties?.stop !== undefined) return h.onStop(Number(stop.properties.stop));
      const line = m.queryRenderedFeatures(box, { layers: ["bus-lines"] })[0];
      if (line && m.getLayoutProperty("bus-lines", "visibility") !== "none" && m.getZoom() >= 12) return h.onLine(Number(line.properties.line));
      h.onPoint([e.lngLat.lng, e.lngLat.lat]);
    };
    m.on("click", pick);
    for (const id of ["bus-stops", "focus-stops", "trip-stops"]) {
      m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
    }
  }

  /**
   * A route callout, as a maps app labels each trip on the map: its time and lines, halfway along its
   * first ride. The chosen trip's is filled; tapping another chooses that trip. Cleared with the trip.
   */
  callout(j: Journey, title: string, sub: string, on: boolean, pick: () => void) {
    const path: LngLat[] = [];
    for (const l of j.legs) {
      if (l.kind !== "ride") continue;
      const v = this.net.lines[l.line].variants[l.variant];
      path.push(...(sliceLine(v.shape, v.along[l.board], v.along[l.alight]) as LngLat[]));
    }
    if (!path.length) return;
    const el = document.createElement("button");
    el.type = "button";
    el.className = `route-callout${on ? " on" : ""}`;
    el.setAttribute("aria-label", `${title}, ${sub}`);
    el.setAttribute("aria-pressed", on ? "true" : "false");
    const strong = document.createElement("strong");
    strong.textContent = title;
    const small = document.createElement("small");
    small.textContent = sub;
    el.append(strong, small);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      pick();
    });
    const mk = this.marker(path[Math.floor(path.length / 2)], el, "bottom");
    this.callouts.push({ mk, path, on });
    this.layoutSoon();
  }

  /**
   * Put each callout where it overlaps nothing, in screen space once the map has stopped moving: the
   * chosen trip's first (always shown), then the others, each trying points along its route. One that
   * finds no room is hidden, as a maps app drops a label rather than pile it on another.
   */
  private layoutSoon() {
    if (this.layoutPending) return;
    this.layoutPending = true;
    const run = () => {
      this.layoutPending = false;
      this.layoutCallouts();
    };
    if (this.map.isMoving()) this.map.once("moveend", run);
    else requestAnimationFrame(run);
  }
  private layoutPending = false;
  /** Place the callouts again: the panel changed size, so the free part of the map did too. */
  relayoutCallouts() {
    if (this.callouts.length) this.layoutSoon();
  }
  private layoutCallouts() {
    // Keep clear of everything else on the map: stop labels, the start and end pins, the panel, the
    // buttons and the credit. A callout half hidden is one a finger can't tap.
    const obstacles = [
      ...this.map.getContainer().querySelectorAll(".stop-badge span, .pin, .maplibregl-ctrl"),
      ...document.querySelectorAll("#app > .sheet, #app > .topbar, #app > .fab"),
    ];
    const placed: DOMRect[] = obstacles.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
    const box = this.map.getContainer().getBoundingClientRect();
    const order = [...this.callouts].sort((a, b) => Number(b.on) - Number(a.on));
    for (const c of order) {
      const el = c.mk.getElement();
      el.style.visibility = "";
      let ok = false;
      for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
        c.mk.setLngLat(c.path[Math.min(c.path.length - 1, Math.floor(c.path.length * f))]);
        const r = el.getBoundingClientRect();
        const inside = r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
        const gap = 8;
        if (inside && placed.every((p) => r.right + gap < p.left || p.right + gap < r.left || r.bottom + gap < p.top || p.bottom + gap < r.top)) {
          placed.push(r);
          ok = true;
          break;
        }
      }
      if (!ok && !c.on) el.style.visibility = "hidden";
      if (!ok && c.on) placed.push(el.getBoundingClientRect());
      el.style.zIndex = c.on ? "2" : "1";
    }
  }

  private callouts: { mk: maplibregl.Marker; path: LngLat[]; on: boolean }[] = [];
  private clearMarkers() {
    this.markers.forEach((mk) => mk.remove());
    this.markers = [];
    this.callouts = [];
  }

  private marker(ll: LngLat, el: HTMLElement, anchor: maplibregl.PositionAnchor = "bottom") {
    const mk = new maplibregl.Marker({ element: el, anchor }).setLngLat(ll).addTo(this.map);
    this.markers.push(mk);
    return mk;
  }

  /** Show the network faintly (home), or hide it while a trip or line is shown. */
  showNetwork(on: boolean) {
    for (const id of ["bus-lines", "bus-stops", "bus-stop-labels"]) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }

  setPins(origin?: LngLat, dest?: LngLat, labels?: { origin: string; dest: string }) {
    this.clearMarkers();
    if (origin) this.marker(origin, pin("origin", labels?.origin), "center");
    if (dest) this.marker(dest, pin("dest", labels?.dest));
  }

  showTrip(j: Journey | null, origin?: LngLat, dest?: LngLat, labels?: { board: string; alight: string; origin: string; dest: string }, alts: Journey[] = []) {
    this.lastAlt = { type: "FeatureCollection", features: alts.flatMap((a) => this.tripLines(a)) };
    (this.map.getSource("trip-alt") as GeoJSONSource | undefined)?.setData(this.lastAlt);
    // Before the map has loaded (or while a new style loads) the layers don't exist yet:
    // what to draw is kept in lastTrip and drawn once they do.
    const src = this.map.getSource("trip") as GeoJSONSource | undefined;
    this.setPins(origin, dest, labels);
    if (!j) {
      this.lastTrip = undefined;
      return src?.setData(empty());
    }
    const features: GeoJSON.Feature[] = [];
    const bounds = new maplibregl.LngLatBounds();
    for (const leg of j.legs) {
      if (leg.kind === "walk") {
        const coords = leg.path ?? [leg.from, leg.to];
        coords.forEach((c) => bounds.extend(c));
        features.push({ type: "Feature", properties: { kind: "walk" }, geometry: { type: "LineString", coordinates: coords } });
        continue;
      }
      const line = this.net.lines[leg.line];
      const v = line.variants[leg.variant];
      const seg = sliceLine(v.shape, v.along[leg.board], v.along[leg.alight]);
      seg.forEach((c) => bounds.extend(c));
      const colour = visible(line.colour, this.dark ? "#111417" : "#ffffff");
      features.push({ type: "Feature", properties: { kind: "ride", colour }, geometry: { type: "LineString", coordinates: seg } });
      for (let i = leg.board; i <= leg.alight; i++)
        features.push({ type: "Feature", properties: { kind: "stop", colour, stop: v.stops[i] }, geometry: { type: "Point", coordinates: this.net.stops[v.stops[i]].ll } });
      this.marker(this.net.stops[v.stops[leg.board]].ll, badge(line.brt ? "Trambus" : line.ref, colour, "board"), "bottom");
      const off = this.net.stops[v.stops[leg.alight]];
      this.marker(off.ll, badge(off.n.d ?? labels?.alight ?? "", colour, "alight"), "bottom");
    }
    this.lastTrip = { type: "FeatureCollection", features };
    src?.setData(this.lastTrip);
    // Frame the other trips too, so their stops are on screen.
    for (const f of this.lastAlt?.features ?? []) if (f.geometry.type === "LineString") f.geometry.coordinates.forEach((c) => bounds.extend(c as [number, number]));
    if (!bounds.isEmpty()) this.fit(bounds);
  }

  /** A trip's walks and rides as lines (no stops or labels): for the faint alternatives. */
  private tripLines(j: Journey): GeoJSON.Feature[] {
    return j.legs.map((leg) => {
      if (leg.kind === "walk") return { type: "Feature", properties: { kind: "walk" }, geometry: { type: "LineString", coordinates: leg.path ?? [leg.from, leg.to] } };
      const v = this.net.lines[leg.line].variants[leg.variant];
      return { type: "Feature", properties: { kind: "ride" }, geometry: { type: "LineString", coordinates: sliceLine(v.shape, v.along[leg.board], v.along[leg.alight]) } };
    });
  }

  showLine(li: number, vi: number) {
    const line = this.net.lines[li];
    const v = line.variants[vi];
    const src = this.map.getSource("focus") as GeoJSONSource | undefined; // see showTrip
    const colour = visible(line.colour, this.dark ? "#111417" : "#ffffff");
    const features: GeoJSON.Feature[] = [
      { type: "Feature", properties: { colour }, geometry: { type: "LineString", coordinates: v.shape } },
      ...v.stops.map((s) => ({ type: "Feature" as const, properties: { colour, stop: s }, geometry: { type: "Point" as const, coordinates: this.net.stops[s].ll } })),
    ];
    this.lastFocus = { type: "FeatureCollection", features };
    src?.setData(this.lastFocus);
    const b = new maplibregl.LngLatBounds();
    v.shape.forEach((c) => b.extend(c));
    if (!b.isEmpty()) this.fit(b);
  }

  clearFocus() {
    this.lastFocus = undefined;
    (this.map.getSource("focus") as GeoJSONSource | undefined)?.setData(empty());
  }
  clearTrip() {
    this.lastTrip = undefined;
    this.lastAlt = undefined;
    (this.map.getSource("trip-alt") as GeoJSONSource | undefined)?.setData(empty());
    this.framed = undefined;
    (this.map.getSource("trip") as GeoJSONSource | undefined)?.setData(empty());
    this.clearMarkers();
  }

  private keepLabelsInside() {
    const box = this.map.getContainer().getBoundingClientRect();
    for (const s of this.map.getContainer().querySelectorAll<HTMLElement>(".stop-badge span")) {
      s.style.translate = "";
      const r = s.getBoundingClientRect();
      const dx = r.right > box.right - 6 ? box.right - 6 - r.right : r.left < box.left + 6 ? box.left + 6 - r.left : 0;
      s.style.translate = dx ? `${dx}px 0` : "";
      s.style.setProperty("--ax", `${-dx}px`);
    }
  }

  /** The credit shows in full at launch, then folds to its (i) button after 5 s or on the first touch (OSMF attribution guidelines allow this). */
  private foldCredit() {
    const el = this.map.getContainer().querySelector(".maplibregl-ctrl-attrib.maplibregl-compact");
    if (!el) return;
    let done = false;
    const fold = () => {
      if (done) return;
      done = true;
      el.classList.remove("maplibregl-compact-show");
      el.removeAttribute("open");
    };
    setTimeout(fold, 5000);
    this.map.once("movestart", fold);
  }

  flyTo(ll: LngLat, zoom = 16) {
    this.map.flyTo({ center: ll, zoom, padding: this.padding(), duration: motion(600) });
  }

  // The trip or line to keep in frame: re-fitted once the map has loaded and when the screen size
  // settles (an iPhone's does, just after opening), until the rider pans or zooms themselves.
  private framed?: maplibregl.LngLatBounds;
  private riderMoved = false;
  fit(b: maplibregl.LngLatBounds) {
    this.framed = b;
    this.riderMoved = false;
    this.map.fitBounds(b, { padding: this.padding(), maxZoom: 16.5, duration: motion(600) });
  }
  private refit() {
    if (this.framed && !this.riderMoved) this.map.fitBounds(this.framed, { padding: this.padding(), maxZoom: 16.5, duration: 0 });
  }

  /** Keep content clear of the panel: bottom sheet on phones, side panel on wide screens. */
  /** Keep the rider's position in the part of the map the panel doesn't cover (ride mode). */
  follow(ll: LngLat) {
    this.map.easeTo({ center: ll, padding: this.padding(), duration: motion(500) });
  }

  padding() {
    const wide = innerWidth >= 900;
    const sheet = document.querySelector<HTMLElement>(".sheet");
    const top = document.querySelector<HTMLElement>(".topbar");
    const sheetH = sheet && !wide ? Math.min(sheet.getBoundingClientRect().height, innerHeight * 0.6) : 0;
    return {
      top: (top && !wide ? top.getBoundingClientRect().bottom : 0) + 60,
      bottom: sheetH + 40,
      left: wide ? 470 : 50,
      right: wide ? 150 : 70,
    };
  }

  setMe(ll: LngLat | null, accuracy = 0) {
    if (!ll) return this.meMarker?.remove();
    if (!this.meMarker) {
      const el = document.createElement("div");
      el.className = "me-dot";
      this.meMarker = new maplibregl.Marker({ element: el, anchor: "center" });
    }
    this.meMarker.getElement().style.setProperty("--acc", `${Math.min(accuracy, 200)}px`);
    this.meMarker.setLngLat(ll).addTo(this.map);
  }
}


function pin(kind: "origin" | "dest", label?: string) {
  const el = document.createElement("div");
  el.className = `pin pin-${kind}`;
  if (label) el.title = label;
  // The destination is a pin whose point sits on the spot (the marker is anchored at its bottom).
  // The start: the same punched round mark as in the fields, outlined so it reads on any map.
  if (kind === "origin")
    el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--origin)" stroke="var(--surface)" stroke-width="2"/><circle cx="12" cy="12" r="3.8" fill="var(--surface)"/></svg>';
  if (kind === "dest")
    el.innerHTML = '<svg viewBox="0 0 24 30" aria-hidden="true"><path d="M12 29s9-9.2 9-16.5A9 9 0 0 0 3 12.5C3 19.8 12 29 12 29z" fill="var(--dest)" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12.5" r="3.6" fill="#fff"/></svg>';
  return el;
}
function badge(text: string, colour: string, kind: "board" | "alight") {
  const el = document.createElement("div");
  el.className = `stop-badge stop-badge-${kind}`;
  // Black or white text on a fill nudged until it reads (white on the Trambus orange didn't).
  const bc = kind === "board" ? badgeColours(colour) : undefined;
  el.style.setProperty("--c", bc?.bg ?? colour);
  if (bc) el.style.setProperty("--on", bc.text);
  const s = document.createElement("span");
  const name = document.createElement("b"); // the name alone, so a long one can end in "…" without clipping the pointer
  name.textContent = text;
  s.append(name);
  el.title = text;
  el.append(s);
  return el;
}
