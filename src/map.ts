import maplibregl, { type GeoJSONSource, type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import { RangeOrWholeSource } from "./tilesource.ts";
import { isDark, onThemeChange } from "./theme.ts";
import { layers, namedFlavor } from "@protomaps/basemaps";
// The package only exports its source entry, so point at the built file directly.
import rtlPluginUrl from "../node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url";
import type { LngLat } from "./geo.ts";
import { sliceLine } from "./geo.ts";
import type { Network } from "./network.ts";
import type { Journey } from "./router.ts";

const base = new URL(import.meta.env.BASE_URL, location.href).href;

// Paper-and-ink map colours, matching the app (see style.css).
const INK = {
  light: { paper: "#f4ecdd", ink: "#15283b", ink2: "#3e5264", marker: "#d9552c", markerSoft: "rgba(217,85,44,0.45)", stop: "#fbf6ec" },
  dark: { paper: "#0f1b26", ink: "#f1e7d4", ink2: "#cdbfa8", marker: "#f07548", markerSoft: "rgba(240,117,72,0.5)", stop: "#142231" },
};
function paperFlavor(dark: boolean) {
  const f = namedFlavor(dark ? "black" : "white");
  const c = dark
    ? { earth: "#0f1b26", water: "#0a2233", park: "#13262a", sand: "#1a2530", building: "#17242f", road: "#22313e", major: "#2a3a48", label: "#cdbfa8", halo: "#0f1b26", minorLabel: "#8f99a0" }
    : { earth: "#f4ecdd", water: "#bcd6de", park: "#e3e6cf", sand: "#efe2c6", building: "#e7dcc7", road: "#fffaf0", major: "#fdf3dc", label: "#3e5264", halo: "#f4ecdd", minorLabel: "#6f7b85" };
  return {
    ...f,
    background: c.earth,
    earth: c.earth,
    water: c.water,
    park_a: c.park,
    park_b: c.park,
    wood_a: c.park,
    wood_b: c.park,
    scrub_a: c.park,
    scrub_b: c.park,
    sand: c.sand,
    beach: c.sand,
    buildings: c.building,
    minor_a: c.road,
    minor_b: c.road,
    minor_service: c.road,
    other: c.road,
    link: c.major,
    major: c.major,
    highway: c.major,
    city_label: c.label,
    city_label_halo: c.halo,
    subplace_label: c.minorLabel,
    subplace_label_halo: c.halo,
    roads_label_minor: c.minorLabel,
    roads_label_minor_halo: c.halo,
    roads_label_major: c.label,
    roads_label_major_halo: c.halo,
    ocean_label: dark ? "#6fb4d3" : "#2b6f8e",
  };
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
      maxBounds: [
        [w - 0.25, s - 0.2],
        [e + 0.25, n + 0.2],
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
    const flavor = paperFlavor(this.dark);
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
  private lastFocus?: FC;
  private restyle() {
    // New base style for the language or theme; then draw our layers again in the new colours.
    this.map.setStyle(this.style(), { diff: false });
    this.map.once("style.load", () => {
      if (!this.handlers) return;
      this.addOverlays(this.handlers, false);
      if (this.lastTrip) (this.map.getSource("trip") as GeoJSONSource).setData(this.lastTrip);
      if (this.lastFocus) (this.map.getSource("focus") as GeoJSONSource).setData(this.lastFocus);
    });
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
    m.addSource("focus", { type: "geojson", data: empty() });

    m.addLayer({
      id: "bus-lines",
      type: "line",
      source: "bus-lines",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", ["get", "brt"], P.marker, P.ink],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "brt"], 2.5, 0.9], 15, ["case", ["get", "brt"], 6, 2.2]],
        "line-opacity": ["case", ["get", "brt"], 0.85, ["get", "routable"], 0.28, 0.12],
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
      paint: { "line-color": P.markerSoft, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 16, 18] },
    });
    m.addLayer({
      id: "focus-line",
      type: "line",
      source: "focus",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.ink, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 16, 3] },
    });
    m.addLayer({
      id: "focus-stops",
      type: "circle",
      source: "focus",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 7],
        "circle-color": P.stop,
        "circle-stroke-color": P.ink,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 2.5],
      },
    });
    // Planned trip: walking is dotted, riding is the line colour.
    m.addLayer({
      id: "trip-walk",
      type: "line",
      source: "trip",
      filter: ["==", ["get", "kind"], "walk"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.ink, "line-width": 3.5, "line-dasharray": [0, 1.7] },
    });
    m.addLayer({
      id: "trip-ride-casing",
      type: "line",
      source: "trip",
      filter: ["==", ["get", "kind"], "ride"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.markerSoft, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 10, 16, 20] },
    });
    m.addLayer({
      id: "trip-ride",
      type: "line",
      source: "trip",
      filter: ["==", ["get", "kind"], "ride"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.ink, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.8, 16, 3.2] },
    });
    m.addLayer({
      id: "trip-stops",
      type: "circle",
      source: "trip",
      filter: ["==", ["get", "kind"], "stop"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 16, 5],
        "circle-color": P.stop,
        "circle-stroke-color": P.ink,
        "circle-stroke-width": 1.8,
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

  private clearMarkers() {
    this.markers.forEach((mk) => mk.remove());
    this.markers = [];
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

  showTrip(j: Journey | null, origin?: LngLat, dest?: LngLat, labels?: { board: string; alight: string; origin: string; dest: string }) {
    const src = this.map.getSource("trip") as GeoJSONSource;
    this.setPins(origin, dest, labels);
    if (!j) {
      this.lastTrip = undefined;
      return src.setData(empty());
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
      features.push({ type: "Feature", properties: { kind: "ride", colour: line.colour }, geometry: { type: "LineString", coordinates: seg } });
      for (let i = leg.board; i <= leg.alight; i++)
        features.push({ type: "Feature", properties: { kind: "stop", colour: line.colour, stop: v.stops[i] }, geometry: { type: "Point", coordinates: this.net.stops[v.stops[i]].ll } });
      this.marker(this.net.stops[v.stops[leg.board]].ll, badge(line.brt ? "Trambus" : line.ref, line.colour, "board"), "bottom");
      const off = this.net.stops[v.stops[leg.alight]];
      this.marker(off.ll, badge(`${labels?.alight ?? ""} ${off.n.d ?? ""}`.trim(), line.colour, "alight"), "bottom");
    }
    this.lastTrip = { type: "FeatureCollection", features };
    src.setData(this.lastTrip);
    if (!bounds.isEmpty()) this.fit(bounds);
  }

  showLine(li: number, vi: number) {
    const line = this.net.lines[li];
    const v = line.variants[vi];
    const src = this.map.getSource("focus") as GeoJSONSource;
    const features: GeoJSON.Feature[] = [
      { type: "Feature", properties: { colour: line.colour }, geometry: { type: "LineString", coordinates: v.shape } },
      ...v.stops.map((s) => ({ type: "Feature" as const, properties: { colour: line.colour, stop: s }, geometry: { type: "Point" as const, coordinates: this.net.stops[s].ll } })),
    ];
    this.lastFocus = { type: "FeatureCollection", features };
    src.setData(this.lastFocus);
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
    (this.map.getSource("trip") as GeoJSONSource | undefined)?.setData(empty());
    this.clearMarkers();
  }

  flyTo(ll: LngLat, zoom = 16) {
    this.map.flyTo({ center: ll, zoom, padding: this.padding(), duration: 600 });
  }

  fit(b: maplibregl.LngLatBounds) {
    this.map.fitBounds(b, { padding: this.padding(), maxZoom: 16.5, duration: 600 });
  }

  /** Keep content clear of the panel: bottom sheet on phones, side panel on wide screens. */
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
  return el;
}
function badge(text: string, colour: string, kind: "board" | "alight") {
  const el = document.createElement("div");
  el.className = `stop-badge stop-badge-${kind}`;
  el.style.setProperty("--c", colour);
  const s = document.createElement("span");
  s.textContent = text;
  el.append(s);
  return el;
}
