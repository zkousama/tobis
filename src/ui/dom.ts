import { textOn, visible } from "./colour.ts";

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

const svg = (body: string, cls = "icon") => {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return s;
};
// GitHub's mark (filled, unlike the line icons), used only to link to the code.
const ghMark = () => {
  const s = document.createElement("span");
  s.className = "icon";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  return s;
};
export const icon = {
  github: ghMark,
  walk: () => svg('<circle cx="13" cy="4" r="2"/><path d="M10 21l1.5-6L9 12l1-5 4 2 2 3"/><path d="M14 14l1.5 7"/><path d="M9 12l-2 2"/>'),
  bus: () => svg('<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16"/><path d="M7 18v2M17 18v2"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/>'),
  swap: () => svg('<path d="M7 4v16M7 20l-3-3M7 20l3-3"/><path d="M17 20V4M17 4l-3 3M17 4l3 3"/>'),
  locate: () => svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>'),
  pin: () => svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  back: () => svg('<path d="M15 18l-6-6 6-6"/>', "icon flip-rtl"),
  close: () => svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  chevron: () => svg('<path d="M9 6l6 6-6 6"/>', "icon flip-rtl"),
  menu: () => svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  search: () => svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  stop: () => svg('<rect x="7" y="2.5" width="10" height="7" rx="1.5"/><path d="M12 9.5V22"/><path d="M9 22h6"/>'),
  place: () => svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/>'),
  clock: () => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  offline: () => svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
  check: () => svg('<path d="M5 12l5 5 9-10"/>'),
  globe: () => svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>'),
  info: () => svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  flag: () => svg('<path d="M5 21V4h11l-2 4 2 4H5"/>'),
  car: () => svg('<path d="M5 16V11l2-5h10l2 5v5"/><path d="M4 16h16v3H4z"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/><path d="M5 11h14"/>'),
  bell: () => svg('<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>'),
  link: () => svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
  arrow: () => svg('<path d="M5 12h14M13 6l6 6-6 6"/>', "icon flip-rtl"),
};

/** A line number in the operator's own colour, readable on any background. */
export function lineBadge(ref: string, colour: string, size: "sm" | "md" | "lg" = "md") {
  const bg = visible(colour, "#ffffff", 1.6);
  const label = ref === "BHNS" ? "Trambus" : ref.startsWith("GT") ? "Grand taxi" : ref;
  return h("span", { class: `badge badge-${size}${ref === "BHNS" || ref.startsWith("GT") ? " badge-brt" : ""}`, style: `--c:${bg};--t:${textOn(bg)}` }, label);
}
