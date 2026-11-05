import type { RideLeg } from "../router.ts";
import { dist } from "../geo.ts";
import { fmtDistance, fmtMinutes, getLang, t, type Key } from "../i18n.ts";
import { h, icon } from "../ui/dom.ts";
import { fmtDH } from "../fares.ts";
import { buildOptions, DEFAULT_VOT, learnVot, nearTie, paretoFront, recommend, tradeoff, VOT_RANGE, winners, type Option, type Part, type Prefs } from "../compare.ts";
import { walkPace } from "../pace.ts";
import { net, nm, render, router, state } from "../app/state.ts";
import { go } from "../app/nav.ts";
import { startTime } from "../app/plan.ts";
import { clock, tripControls } from "./tripopts.ts";
import { cardDue, dataNote, legChips, linesAt, previewTrip, stopLine, variantOf } from "./common.ts";

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
  return h("div", { class: "results" }, to?.sub ? h("p", { class: "muted", style: "margin:2px 0 4px" }, nm(to.sub)) : null, tripControls(), longWalk, compareBlock(), nearBlock, dataNote());
}

// ---------- comparing every way to get there ----------
// Options are ranked by generalised cost: price plus time, priced at the
// rider's own value of time (the slider), walking and waiting weighted heavier.
export function getPrefs(): Prefs {
  let vot = DEFAULT_VOT;
  let avoidWalk = false;
  try {
    const v = Number(localStorage.getItem("vot"));
    if (v >= VOT_RANGE[0] && v <= VOT_RANGE[1]) vot = v;
    avoidWalk = localStorage.getItem("avoidWalk") === "1";
  } catch {}
  return { vot, walkWeight: avoidWalk ? 3 : 1.5 };
}
export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem("vot", p.vot.toFixed(4));
    localStorage.setItem("avoidWalk", p.walkWeight > 2 ? "1" : "0");
  } catch {}
}
export const toSlider = (vot: number) => Math.round((100 * Math.log(vot / VOT_RANGE[0])) / Math.log(VOT_RANGE[1] / VOT_RANGE[0]));
export const fromSlider = (v: number) => VOT_RANGE[0] * (VOT_RANGE[1] / VOT_RANGE[0]) ** (v / 100);
export let showAllOptions = false;
export let prefsOpen = false;
export function compareBlock() {
  if (!state.from || !state.to) return null;
  // Arrive by: the night note and the clock work from when the trip would leave, about an hour before.
  const w = state.when;
  const at = w.mode === "arrive" ? new Date(w.at - 3600_000) : startTime();
  const { options, note, night } = buildOptions(net, state.journeys, state.from.ll, state.to.ll, at, walkPace());
  // Clock times on each option: "07:30 → 08:16", or for arrive by, the latest time to leave.
  const clockText = (o: Option) => {
    if (w.mode === "arrive") {
      const leave = new Date(w.at - o.range[1] * 1000);
      return leave.getTime() < Date.now() ? t("tooLate") : t("leaveBefore", clock(leave));
    }
    const t0 = startTime();
    return `${clock(t0)} → ${clock(new Date(t0.getTime() + o.seconds * 1000))}`;
  };
  const prefs = getPrefs();
  // Drop options that are worse than another on time, price and walking at once.
  const front = paretoFront(options);
  const hidden = options.length - front.length;
  const win = winners(options);
  const list = h("div", { class: "options" });
  const worth = h("small", { class: "muted pref-worth" });
  const summary = h("span", { class: "pref-summary" });
  const draw = () => {
    const ranked = recommend(showAllOptions ? options : front, prefs);
    const longest = Math.max(...ranked.map((o) => o.range[1]), 1);
    worth.textContent = t("votLabel", Math.round(prefs.vot * 60));
    summary.textContent = t("prefSummary", prefs.vot < 0.07 ? t("prefSave") : prefs.vot > 0.35 ? t("prefTime") : t("prefBalanced"), Math.round(prefs.vot * 60));
    list.replaceChildren(
      ...ranked.map((o, i) =>
        optionRow(
          o,
          i === 0,
          // The top option just says so; the others say what they're best at.
          (i === 0 ? [t("recommended")] : [nearTie(ranked[0], o, prefs) && t("nearTie"), win.fast === o && t("prioFast"), win.cheap === o && t("prioCheap"), win.walk === o && t("prioWalk")]).filter(Boolean) as string[],
          longest,
          i === 0 ? null : tradeText(ranked[0], o),
          clockText(o),
          () => {
            // Picking something other than the top option teaches the app a little.
            const next = { ...prefs, vot: learnVot(o, options, prefs) };
            savePrefs(next);
          },
        ),
      ),
    );
    const top = ranked[0];
    if (top?.journey !== undefined) previewTrip(top.journey);
  };
  const slider = h("input", {
    type: "range",
    min: 0,
    max: 100,
    value: toSlider(prefs.vot),
    class: "pref-slider",
    "aria-label": t("prefTitle"),
    oninput: (e: Event) => {
      prefs.vot = fromSlider(Number((e.target as HTMLInputElement).value));
      savePrefs(prefs);
      draw();
    },
  });
  const walkToggle = h(
    "button",
    {
      class: `chip-toggle${prefs.walkWeight > 2 ? " on" : ""}`,
      "aria-pressed": prefs.walkWeight > 2 ? "true" : "false",
      onclick: () => {
        prefs.walkWeight = prefs.walkWeight > 2 ? 1.5 : 3;
        savePrefs(prefs);
        walkToggle.classList.toggle("on", prefs.walkWeight > 2);
        walkToggle.setAttribute("aria-pressed", prefs.walkWeight > 2 ? "true" : "false");
        draw();
      },
    },
    h("span", { class: "tick" }, icon.check()),
    icon.walk(),
    t("avoidWalk"),
  );
  draw();
  // Folded by default: the options come first, the knob is one tap away.
  const panel = h("div", { class: "pref-panel", hidden: !prefsOpen }, h("div", { class: "pref-row" }, h("span", { class: "pref-end" }, t("prefSave")), slider, h("span", { class: "pref-end" }, t("prefTime"))), worth);
  const opener = h(
    "button",
    {
      class: "pref-open",
      "aria-label": t("prefTitle"),
      "aria-expanded": prefsOpen ? "true" : "false",
      onclick: () => {
        prefsOpen = !prefsOpen;
        panel.hidden = !prefsOpen;
        opener.setAttribute("aria-expanded", prefsOpen ? "true" : "false");
      },
    },
    summary,
    icon.chevron(),
  );
  return h(
    "div",
    { class: "compare" },
    h("div", { class: "prefs" }, h("div", { class: "pref-row pref-row-2" }, opener, walkToggle), panel),
    night ? h("p", { class: "tip tip-night" }, icon.clock(), h("small", null, t("nightNote"))) : null,
    h(
      "p",
      { class: "bar-legend", "aria-hidden": "true" },
      h("span", { class: "key key-ride" }),
      t("legendRide"),
      h("span", { class: "key key-walk" }),
      t("legendWalk"),
      h("span", { class: "key key-wait" }),
      t("legendWait"),
    ),
    list,
    hidden > 0
      ? h(
          "button",
          {
            class: "link show-all",
            onclick: () => {
              showAllOptions = !showAllOptions;
              render();
            },
          },
          showAllOptions ? t("hideWorse") : hidden === 1 ? t("showWorseOne") : t("showWorse", hidden),
        )
      : null,
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

export function timeBar(o: Option, longest: number, spoken: string) {
  const total = o.parts.reduce((n, p) => n + p.s, 0) || 1;
  const label: Record<Part["k"], Key> = { walk: "legendWalk", wait: "legendWait", ride: "legendRide" };
  // The bar is the likely time; the faint tail reaches the slow end of the range.
  const tail = Math.max(0, o.range[1] - o.seconds);
  return h(
    "div",
    { class: "tbar-track", role: "img", "aria-label": spoken, title: spoken },
    h(
      "div",
      { class: "tbar", style: `width:${Math.max(14, (o.seconds / longest) * 100)}%` },
      o.parts
        .filter((p) => p.s > 20)
        .map((p) => h("span", { class: `seg seg-${p.k}`, style: `flex-grow:${p.s / total};${p.colour ? `--c:${p.colour}` : ""}`, title: `${t(label[p.k])} · ${fmtMinutes(p.s)}` })),
    ),
    tail > 60 ? h("span", { class: "tbar-tail", style: `width:${(tail / longest) * 100}%`, title: t("rangeTitle") }) : null,
  );
}

export function breakdown(o: Option) {
  const sum = (k: Part["k"]) => o.parts.filter((p) => p.k === k).reduce((n, p) => n + p.s, 0);
  return [
    sum("walk") > 30 ? t("bdWalk", fmtMinutes(sum("walk"))) : null,
    sum("wait") > 30 ? t("bdWait", fmtMinutes(sum("wait"))) : null,
    sum("ride") > 30 ? t("bdRide", fmtMinutes(sum("ride"))) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function optionRow(o: Option, first: boolean, tags: string[], longest: number, trade: string | null, clockLine: string | null, onChoose: () => void) {
  const j = o.journey !== undefined ? state.journeys[o.journey] : undefined;
  let head: Node;
  let sub: string;
  if (o.kind === "transit" && j) {
    const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
    head = legChips(j);
    sub = `${nm(net.stops[variantOf(rides[0]).stops[rides[0].board]].n)} · ${rides.length > 1 ? `${rides.length - 1} ${rides.length > 2 ? t("changes") : t("change")}` : t("direct")}`;
  } else if (o.kind === "walk") {
    head = h("span", { class: "mode-name" }, icon.walk(), t("walkAll"));
    sub = fmtDistance(o.walkMetres);
  } else {
    head = h("span", { class: "mode-name" }, icon.car(), o.kind === "airportTaxi" ? t("airportTaxi") : t("petitTaxi"));
    sub = o.kind === "airportTaxi" ? t("airportTaxiSub") : `${t("petitTaxiSub")}${o.nightRate ? ` · ${t("petitTaxiNight")}` : ""}`;
  }
  const price = !o.cost
    ? t("fareUnknown")
    : o.cost.high === 0
      ? t("free")
      : o.cost.low === o.cost.high
        ? `≈ ${fmtDH(o.cost.low)}${o.perCar ? ` ${t("perCar")}` : ""}`
        : `≈ ⁦${o.cost.low}–${o.cost.high} DH⁩`;
  const [lo, hi] = o.range.map((x) => Math.max(1, Math.round(x / 60)));
  const body = [
    h(
      "div",
      { class: "opt-top" },
      h(
        "div",
        { class: "opt-main" },
        tags.length ? h("div", { class: "opt-tags" }, tags.map((x) => h("span", { class: "opt-tag" }, x))) : null,
        head,
        h("span", { class: "journey-sub" }, sub),
        clockLine ? h("span", { class: "opt-clock" }, clockLine) : null,
      ),
      h(
        "div",
        { class: "ticket-stub" },
        h("span", { class: "ticket-time" }, String(Math.max(1, Math.round(o.seconds / 60))), h("small", null, t("min"))),
        hi > lo ? h("span", { class: "ticket-range" }, `⁦${lo}–${hi}⁩ ${t("min")}`) : null,
        h("span", { class: "ticket-fare" }, price),
        cardDue(j) ? h("span", { class: "ticket-card" }, t("cardPlus", fmtDH(cardDue(j)!))) : null,
      ),
    ),
    timeBar(o, longest, breakdown(o)),
    trade ? h("p", { class: "opt-trade" }, trade) : null,
  ];
  if (o.journey === undefined) return h("div", { class: `option${first ? " best" : ""}` }, body);
  const ji = o.journey;
  return h(
    "button",
    {
      class: `option${first ? " best" : ""}`,
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
