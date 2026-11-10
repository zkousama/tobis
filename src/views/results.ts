import { dist } from "../geo.ts";
import { fmtDistance, fmtMinutes, getLang, t } from "../i18n.ts";
import { h, icon } from "../ui/dom.ts";
import { fmtDH } from "../fares.ts";
import { buildOptions, learnVot, nearTie, recommend, tradeoff, winners, type Option } from "../compare.ts";
import { getPrefs, savePrefs } from "../app/prefs.ts";
import { walkPace } from "../pace.ts";
import { net, nm, router, state } from "../app/state.ts";
import { go } from "../app/nav.ts";
import { startTime } from "../app/plan.ts";
import { clock, tripControls } from "./tripopts.ts";
import { departFor } from "../depart.ts";
import { cardDue, dataNote, legChips, linesAt, previewTrip, stopLine } from "./common.ts";

export function resultsBody() {
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
      tripControls(),
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
  // No bus within the usual walk: say how far the first stop is, before the options.
  const firstWalk = state.journeys.find((j) => j.rides > 0)?.legs[0];
  const longWalk = state.widened && firstWalk?.kind === "walk" ? h("p", { class: "tip tip-walk" }, icon.walk(), h("small", null, t("longWalk", fmtMinutes(firstWalk.seconds)))) : null;
  return h("div", { class: "results" }, tripControls(), compareBlock(longWalk), nearBlock, dataNote());
}

// ---------- comparing every way to get there ----------
// Options are ranked by generalised cost: price plus time, priced at the
// rider's own value of time (the slider), walking and waiting weighted heavier.
export function compareBlock(extraNote: Node | null = null) {
  if (!state.from || !state.to) return null;
  // Arrive by: the night note and the clock work from when the trip would leave, about an hour before.
  const w = state.when;
  const at = w.mode === "arrive" ? new Date(w.at - 3600_000) : startTime();
  const { options, note, night, evening } = buildOptions(net, state.journeys, state.from.ll, state.to.ll, at, walkPace());
  // What a maps app shows on each trip: leave – arrive, when the bus comes and from where, the walk to it.
  const cardTimes = (o: Option): CardTimes => {
    const j = o.journey !== undefined ? state.journeys[o.journey] : undefined;
    const d = j ? departFor(net, j, startTime()) : undefined;
    const minutes = Math.max(1, Math.round((d ? d.arrive.getTime() - d.leave.getTime() : o.seconds * 1000) / 60000));
    const line = d?.line !== undefined ? net.lines[d.line] : undefined;
    const stopName = d?.stop !== undefined ? nm(net.stops[d.stop].n) : "";
    const lineName = line ? (line.brt ? t("brt") : `${t("lineWord")} ${line.ref}`) : "";
    const catchLine = !line ? null : d!.catchAt && w.mode !== "arrive" ? t("catchAt", lineName, clock(d!.catchAt), stopName) : t("fromStop", stopName);
    const walk = d && d.walkSeconds > 30 ? `${fmtMinutes(d.walkSeconds)} ${t("walkMin")}` : null;
    const every = d?.everyMinutes ? (line?.headway ? t("everyN", d.everyMinutes) : t("everyAbout", d.everyMinutes)) : null;
    let times: string;
    if (w.mode === "arrive") {
      const leave = new Date(w.at - o.range[1] * 1000);
      times = leave.getTime() < Date.now() ? t("tooLate") : t("leaveBefore", clock(leave));
    } else {
      const leave = d?.leave ?? startTime();
      times = `${clock(leave)} – ${clock(d?.arrive ?? new Date(leave.getTime() + o.seconds * 1000))}`;
    }
    return { times, minutes, catchLine, walkLine: [walk, every].filter(Boolean).join(" · ") || null };
  };
  const prefs = getPrefs();
  // Every trip is shown, best first (as in a maps app): a slower trip from another stop nearby is
  // still a choice the rider may want, so none is hidden behind a link.
  const win = winners(options);
  const list = h("div", { class: "options" });
  // A long walk to the first stop is told under the first trip. Late at night the warning comes first:
  // it changes what every trip below can promise.
  const notes = [extraNote].filter(Boolean) as Node[];
  const nightWarning = night ? h("p", { class: "tip tip-night", role: "note" }, icon.clock(), h("span", null, t("nightNote"))) : null;
  // From the evening on, a bus whose line publishes no hours may well not come.
  const unsure = (o: Option) => {
    if (!evening || o.journey === undefined) return false;
    return state.journeys[o.journey].legs.some((l) => l.kind === "ride" && !net.lines[l.line].hours);
  };
  const draw = (preview = true) => {
    const ranked = recommend(options, prefs);
    const longest = Math.max(...ranked.map((o) => o.range[1]), 1);
    list.replaceChildren(
      ...ranked.flatMap((o, i) => [
        optionRow(
          o,
          i === 0,
          // The top option just says so; the others say what they're best at.
          [...(unsure(o) ? [t("nightUnsure")] : []), ...(i === 0 ? [t("recommended")] : [nearTie(ranked[0], o, prefs) && t("nearTie"), win.fast === o && t("prioFast"), win.cheap === o && t("prioCheap"), win.walk === o && t("prioWalk")])].filter(Boolean) as string[],
          longest,
          i === 0 ? null : tradeText(ranked[0], o),
          cardTimes(o),
          () => {
            // Picking something other than the top option teaches the app a little.
            const next = { ...prefs, vot: learnVot(o, options, prefs) };
            savePrefs(next);
          },
        ),
        ...(i === 0 ? notes : []),
      ]),
    );
    const top = ranked[0];
    if (preview && top?.journey !== undefined) previewTrip(top.journey);
  };
  draw();
  // "Leave now" times move with the clock: refresh them every minute while the list is on screen.
  if (w.mode === "now") {
    const tick = window.setInterval(() => (list.isConnected ? draw(false) : window.clearInterval(tick)), 60_000);
  }
  return h(
    "div",
    { class: "compare" },
    nightWarning,
    list,
    note ? h("p", { class: "tip" }, h("span", { class: "row-main" }, h("strong", null, t("petitTaxi")), h("small", null, t("petitTaxiOtherTown", note.town)))) : null,
  );
}

/** "2.5 DH less · 10 min more" compared with the recommended option. */
export function tradeText(best: Option, o: Option) {
  const { dMin, dDH } = tradeoff(best, o);
  const bits: string[] = [];
  if (dDH !== undefined && dDH !== 0) bits.push(dDH < 0 ? t("tradeCheaper", fmtNum(-dDH)) : t("tradeDearer", fmtNum(dDH)));
  if (Math.abs(dMin) >= 1) bits.push(dMin > 0 ? t("tradeSlower", dMin) : t("tradeFaster", -dMin));
  return bits.length ? bits.join(" · ") : null;
}
export const fmtNum = (n: number) => (n % 1 ? n.toFixed(1).replace(".", getLang() === "en" ? "." : ",") : String(n));



export interface CardTimes {
  times: string; // "10:14 – 10:58", or "Partez avant 07:05"
  minutes: number;
  catchLine: string | null; // "Trambus à 10:19 de Rue de la Foire"
  walkLine: string | null; // "5 min à pied · toutes les 10 min"
}

// A trip, the way a maps app lists it: times and duration, the lines, when and where to get on, the walk.
export function optionRow(o: Option, first: boolean, tags: string[], _longest: number, trade: string | null, when: CardTimes, onChoose: () => void) {
  const j = o.journey !== undefined ? state.journeys[o.journey] : undefined;
  let head: Node;
  if (o.kind === "transit" && j) head = legChips(j);
  else if (o.kind === "walk") head = h("span", { class: "mode-name" }, icon.walk(), `${t("walkAll")} · ${fmtDistance(o.walkMetres)}`);
  else head = h("span", { class: "mode-name" }, icon.car(), o.kind === "airportTaxi" ? `${t("airportTaxi")} · ${t("airportTaxiSub")}` : t("petitTaxi"));
  const price = !o.cost
    ? t("fareUnknown")
    : o.cost.high === 0
      ? t("free")
      : o.cost.low === o.cost.high
        ? `≈ ${fmtDH(o.cost.low)}${o.perCar ? ` ${t("perCar")}` : ""}`
        : `≈ ⁦${o.cost.low}–${o.cost.high} DH⁩`;
  const hi = Math.max(1, Math.round(o.range[1] / 60));
  const body = [
    tags.length ? h("div", { class: "opt-tags" }, tags.map((x) => h("span", { class: `opt-tag${x === t("nightUnsure") ? " opt-tag-warn" : ""}` }, x))) : null,
    h("div", { class: "opt-row" }, h("span", { class: "opt-clock" }, when.times), h("span", { class: "ticket-time" }, String(when.minutes), h("small", null, t("min")))),
    h("div", { class: "opt-row" }, head, h("span", { class: "ticket-fare" }, price)),
    when.catchLine ? h("p", { class: "opt-catch" }, when.catchLine) : null,
    when.walkLine || hi > when.minutes + 1 || cardDue(j)
      ? h(
          "p",
          { class: "opt-meta" },
          when.walkLine ? h("span", null, icon.walk(), when.walkLine) : null,
          hi > when.minutes + 1 ? h("span", { title: t("rangeTitle") }, t("upTo", `\u2066${hi}\u2069 ${t("min")}`)) : null,
          cardDue(j) ? h("span", null, t("cardPlus", fmtDH(cardDue(j)!))) : null,
        )
      : null,
    trade ? h("p", { class: "opt-trade" }, trade) : null,
  ];
  if (o.journey === undefined) return h("div", { class: `option${first ? " best" : ""}` }, body);
  const ji = o.journey;
  return h(
    "button",
    {
      class: `option${first ? " best" : ""}`,
      "data-j": ji,
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
