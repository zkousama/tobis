import { waitFor, type RideLeg } from "../router.ts";
import { bearing, type LngLat } from "../geo.ts";
import { fmtDistance, fmtMinutes, fmtStops, getLang, t } from "../i18n.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import { visible } from "../ui/colour.ts";
import { fareFor, fmtDH, hasCard } from "../fares.ts";
import { net, nm, render, state } from "../app/state.ts";
import { go } from "../app/nav.ts";
import { cardNote, header, journeyFare, legChips, stopLine, variantOf } from "./common.ts";

export const DIRS = {
  fr: ["le nord", "le nord-est", "l'est", "le sud-est", "le sud", "le sud-ouest", "l'ouest", "le nord-ouest"],
  ar: ["الشمال", "الشمال الشرقي", "الشرق", "الجنوب الشرقي", "الجنوب", "الجنوب الغربي", "الغرب", "الشمال الغربي"],
  en: ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"],
};
export function heading(a: LngLat, b: LngLat) {
  const i = Math.round(bearing(a, b) / 45) % 8;
  const lang = getLang();
  return lang === "fr" ? `vers ${DIRS.fr[i]}` : lang === "ar" ? `جهة ${DIRS.ar[i]}` : `head ${DIRS.en[i]}`;
}

// A trip as a vertical route: dotted line for walking, the line's colour for
// riding, a dot at each place you change what you're doing.
export function tripBody(index: number) {
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
    const rideIdx = j.legs.filter((l) => l.kind === "ride");
    const firstRide = rideIdx[0] === leg;
    const lastRide = rideIdx.at(-1) === leg;
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
          firstRide ? h("button", { class: "link tl-other", onclick: () => go({ name: "pickStop", which: "board" }) }, t("otherStop")) : null,
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
          fare?.firstCard && !hasCard(line.ref) ? cardNote(line.ref, fare.firstCard, fare.normal, render) : null,
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
          lastRide ? h("button", { class: "link tl-other", onclick: () => go({ name: "pickStop", which: "alight" }) }, t("otherStop")) : null,
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
