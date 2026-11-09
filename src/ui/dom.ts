import { badgeColours, visible } from "./colour.ts";
import walkSvg from "../../node_modules/@tabler/icons/icons/outline/walk.svg?raw";
import busSvg from "../../node_modules/@tabler/icons/icons/outline/bus.svg?raw";
import swapSvg from "../../node_modules/@tabler/icons/icons/outline/arrows-up-down.svg?raw";
import locateSvg from "../../node_modules/@tabler/icons/icons/outline/current-location.svg?raw";
import pinSvg from "../../node_modules/@tabler/icons/icons/outline/map-pin.svg?raw";
import backSvg from "../../node_modules/@tabler/icons/icons/outline/chevron-left.svg?raw";
import closeSvg from "../../node_modules/@tabler/icons/icons/outline/x.svg?raw";
import chevronSvg from "../../node_modules/@tabler/icons/icons/outline/chevron-right.svg?raw";
import menuSvg from "../../node_modules/@tabler/icons/icons/outline/menu-2.svg?raw";
import searchSvg from "../../node_modules/@tabler/icons/icons/outline/search.svg?raw";
import stopSvg from "../../node_modules/@tabler/icons/icons/outline/bus-stop.svg?raw";
import placeSvg from "../../node_modules/@tabler/icons/icons/outline/building-store.svg?raw";
import clockSvg from "../../node_modules/@tabler/icons/icons/outline/clock.svg?raw";
import offlineSvg from "../../node_modules/@tabler/icons/icons/outline/cloud-off.svg?raw";
import downloadSvg from "../../node_modules/@tabler/icons/icons/outline/download.svg?raw";
import checkSvg from "../../node_modules/@tabler/icons/icons/outline/check.svg?raw";
import globeSvg from "../../node_modules/@tabler/icons/icons/outline/world.svg?raw";
import infoSvg from "../../node_modules/@tabler/icons/icons/outline/info-circle.svg?raw";
import flagSvg from "../../node_modules/@tabler/icons/icons/outline/flag.svg?raw";
import volumeSvg from "../../node_modules/@tabler/icons/icons/outline/volume.svg?raw";
import volumeOffSvg from "../../node_modules/@tabler/icons/icons/outline/volume-off.svg?raw";
import carSvg from "../../node_modules/@tabler/icons/icons/outline/car.svg?raw";
import bellSvg from "../../node_modules/@tabler/icons/icons/outline/bell-ringing.svg?raw";
import linkSvg from "../../node_modules/@tabler/icons/icons/outline/link.svg?raw";
import arrowSvg from "../../node_modules/@tabler/icons/icons/filled/navigation.svg?raw";
import roadSvg from "../../node_modules/@tabler/icons/icons/outline/road.svg?raw";
import destSvg from "../../node_modules/@tabler/icons/icons/filled/map-pin.svg?raw";

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Small element builder: h("div", { class: "x", onclick }, child, ...). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && k !== "style" && k !== "class" && !k.startsWith("aria-") && !k.startsWith("data-")) (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k === "class" ? "class" : k, v === true ? "" : String(v));
    }
  append(el, children);
  return el;
}
function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

// GitHub's mark (filled, unlike the line icons), used only to link to the code.
const ghMark = () => {
  const s = document.createElement("span");
  s.className = "icon";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  return s;
};
// Icons: Tabler Icons (MIT, tabler.io/icons), one set drawn on the same 24px grid with the
// same 2px rounded stroke. Only these are bundled. Arrows that point along the reading
// direction flip in Darija.
const tabler = (raw: string, cls = "icon") => () => {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = raw.replace(/\s(width|height|class)="[^"]*"/g, "");
  return s;
};
// Where a trip starts: a solid round mark with its centre punched out, the partner of the
// destination's filled pin (same weight, same hole; the background shows through in any theme).
const originMark = () => {
  const s = document.createElement("span");
  s.className = "icon icon-origin";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM12 8.6a3.4 3.4 0 1 1 0 6.8a3.4 3.4 0 1 1 0-6.8z"/></svg>';
  return s;
};
// "Towards": a short shaft and a big open head, so it reads as an arrow at text size
// (the font's "→" is a long line with a tiny head). Points the other way in Darija.
const towardMark = () => {
  const s = document.createElement("span");
  s.className = "icon icon-toward flip-rtl";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12h12"/><path d="M12 5.5l6.5 6.5-6.5 6.5"/></svg>';
  return s;
};
export const icon = {
  github: ghMark,
  origin: originMark,
  toward: towardMark,
  walk: tabler(walkSvg),
  bus: tabler(busSvg),
  swap: tabler(swapSvg),
  locate: tabler(locateSvg),
  pin: tabler(pinSvg),
  back: tabler(backSvg, "icon flip-rtl"),
  close: tabler(closeSvg),
  chevron: tabler(chevronSvg, "icon flip-rtl"),
  menu: tabler(menuSvg),
  search: tabler(searchSvg),
  stop: tabler(stopSvg),
  place: tabler(placeSvg),
  clock: tabler(clockSvg),
  offline: tabler(offlineSvg),
  download: tabler(downloadSvg),
  check: tabler(checkSvg),
  globe: tabler(globeSvg),
  info: tabler(infoSvg),
  flag: tabler(flagSvg),
  volume: tabler(volumeSvg),
  volumeOff: tabler(volumeOffSvg),
  car: tabler(carSvg),
  bell: tabler(bellSvg),
  link: tabler(linkSvg),
  arrow: tabler(arrowSvg), // "Démarrer": the navigation arrowhead, like a maps app's Start
  road: tabler(roadSvg),
  dest: tabler(destSvg, "icon icon-dest"), // where you're going: a filled pin
};


/** A line number in the operator's own colour, readable on any background. */
export function lineBadge(ref: string, colour: string, size: "sm" | "md" | "lg" = "md") {
  const { bg, text } = badgeColours(visible(colour, "#ffffff", 1.6));
  const label = ref === "BHNS" ? "Trambus" : ref.startsWith("GT") ? "Grand taxi" : ref;
  return h("span", { class: `badge badge-${size}${ref === "BHNS" || ref.startsWith("GT") ? " badge-brt" : ""}`, style: `--c:${bg};--t:${text}` }, label);
}
