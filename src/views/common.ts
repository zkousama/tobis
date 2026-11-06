import type { Journey, RideLeg } from "../router.ts";
import { dist } from "../geo.ts";
import { getLang, t } from "../i18n.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import { fareFor, fmtDH, hasCard, setHasCard } from "../fares.ts";
import { bmap, current, net, nm, state } from "../app/state.ts";
import { back } from "../app/nav.ts";

// Pieces several screens share.
export function header(title: Node | string, sub?: Node | string | null) {
  return h(
    "div",
    { class: "view-head" },
    h("button", { class: "icon-btn", "aria-label": t("back"), onclick: back }, icon.back()),
    h("div", { class: "view-title" }, h("h2", null, title), sub ? h("p", { class: "muted" }, sub) : null),
  );
}

export function dataNote() {
  const d = net.osmTimestamp ? new Date(net.osmTimestamp) : undefined;
  const lang = getLang() === "ar" ? "ar-MA" : getLang();
  return h("p", { class: "fine" }, `${t("dataFrom")} ${d ? d.toLocaleDateString(lang) : "?"}. ${t("estimates")}`);
}

export function linesAt(stop: number, max = 99) {
  const refs = new Map<number, string>();
  const s = net.stops[stop];
  net.stops.forEach((o, oi) => {
    if (oi !== stop && !(o.n.d === s.n.d && dist(o.ll, s.ll) < 120)) return;
    net.lines.forEach((l, li) => l.variants.forEach((v) => v.stops.includes(oi) && refs.set(li, l.ref)));
  });
  const items = [...refs.keys()].slice(0, max);
  return h("span", { class: "badges" }, items.map((li) => lineBadge(net.lines[li].ref, net.lines[li].colour, "sm")), refs.size > max ? h("small", { class: "muted" }, `+${refs.size - max}`) : null);
}

export function legChips(j: Journey) {
  const parts: Node[] = [];
  j.legs.forEach((l, i) => {
    if (i) parts.push(h("span", { class: "chev" }, icon.chevron()));
    if (l.kind === "walk") parts.push(h("span", { class: "walk-chip" }, icon.walk(), h("span", null, Math.max(1, Math.round(l.seconds / 60)))));
    else parts.push(lineBadge(net.lines[l.line].ref, net.lines[l.line].colour, "sm"));
  });
  return h("div", { class: "legs" }, parts);
}

export const variantOf = (l: RideLeg) => net.lines[l.line].variants[l.variant];

export function journeyFare(j: Journey) {
  let total = 0;
  for (const l of j.legs) {
    if (l.kind !== "ride") continue;
    const f = fareFor(net.lines[l.line], variantOf(l), l.board, l.alight);
    if (!f) return undefined;
    total += f.normal;
  }
  return total || undefined;
}

export function settingToggle(label: string, on: () => boolean, flip: () => void) {
  const b = h(
    "button",
    {
      class: "setting-row",
      role: "switch",
      "aria-checked": on() ? "true" : "false",
      onclick: () => {
        flip();
        b.setAttribute("aria-checked", on() ? "true" : "false");
      },
    },
    h("span", { class: "setting-label" }, label),
    h("span", { class: "switch" }),
  );
  return b;
}

// The card a journey needs and the rider hasn't said they own (the Trambus card).
export function cardDue(j: Journey | undefined): number | undefined {
  if (!j) return;
  for (const l of j.legs) {
    if (l.kind !== "ride") continue;
    const line = net.lines[l.line];
    if (line.fare?.kind === "flat" && line.fare.firstCard && !hasCard(line.ref)) return line.fare.firstCard;
  }
}
// What the card is, and a way to say you have it.
export function cardNote(ref: string, first: number, ride: number, onChange: () => void) {
  const on = hasCard(ref);
  return h(
    "div",
    { class: "card-note" },
    h("p", null, t("cardFirst", fmtDH(first), fmtDH(ride))),
    h(
      "button",
      {
        class: `chip-toggle${on ? " on" : ""}`,
        "aria-pressed": on ? "true" : "false",
        onclick: () => {
          setHasCard(ref, !hasCard(ref));
          onChange();
        },
      },
      h("span", { class: "tick" }, icon.check()),
      t("haveCard"),
    ),
  );
}

export function previewTrip(i: number) {
  const j = state.journeys[i];
  if (!j) return;
  // The other bus trips on offer go on the map too, faint, as a maps app shows them.
  const alts = current().name === "results" ? state.journeys.filter((x, k) => k !== i && x.rides > 0) : [];
  bmap?.showTrip(j, state.from?.ll, state.to?.ll, { board: "", alight: t("getOff"), origin: nm(state.from?.label), dest: nm(state.to?.label) }, alts);
}

export function stopLine(stop: number) {
  const s = net.stops[stop];
  const near = s.near !== undefined ? net.places[s.near] : undefined;
  const area = s.area !== undefined ? net.places[s.area] : undefined;
  const bits = [near ? `${t("near")} ${nm(near.n)}` : null, area ? nm(area.n) : null].filter(Boolean);
  return bits.length ? h("small", { class: "muted" }, bits.join(" · ")) : null;
}

export function segmented<T extends string>(options: { id: T; label: string; lang?: string }[], currentId: T, pick: (id: T) => void) {
  return h(
    "div",
    { class: "segmented" },
    options.map((o) => h("button", { class: o.id === currentId ? "on" : "", lang: o.lang, "aria-pressed": o.id === currentId ? "true" : "false", onclick: () => pick(o.id) }, o.label)),
  );
}
