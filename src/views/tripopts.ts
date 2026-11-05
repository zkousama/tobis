// The controls between the two fields and the trip options, like a maps app:
// when you leave (now, at a time, or arrive by a time), which ways to travel and
// which lines to leave out, and the stops you chose to walk to or get off at.
import { fmtMinutes, getLang, t } from "../i18n.ts";
import { DETOUR, WALK_SPEED } from "../router.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import { net, nm, render, router, state } from "../app/state.ts";
import { avoidedLines, plan, setAvoided, setMode, skipBrt, skipBus } from "../app/plan.ts";
import { header, linesAt, segmented, settingToggle } from "./common.ts";
import { getPrefs, prefsChanged, routeOf, routePrefs, savePrefs, type RoutePref } from "../app/prefs.ts";
import { DEFAULT_VOT } from "../compare.ts";

/** "07:30", 24-hour in every language, as timetables in Morocco are written. */
export const clock = (d: Date) => `⁦${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}⁩`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function dayLabel(d: Date) {
  const days = Math.round((dayStart(d).getTime() - dayStart(new Date()).getTime()) / 86400_000);
  if (days === 0) return t("today");
  if (days === 1) return t("tomorrow");
  return new Intl.DateTimeFormat(getLang() === "ar" ? "ar-MA" : getLang(), { weekday: "short", day: "numeric" }).format(d);
}
/** What the "when" chip says: "Partir maintenant", "Départ 07:30 · demain", "Arrivée avant 08:00". */
export function whenSummary() {
  const w = state.when;
  if (w.mode === "now") return t("whenNow");
  const d = new Date(w.at);
  const day = dayStart(d).getTime() === dayStart(new Date()).getTime() ? "" : ` · ${dayLabel(d)}`;
  return `${t(w.mode === "depart" ? "whenSummaryDepart" : "whenSummaryArrive", clock(d))}${day}`;
}
/** How many options the rider changed: shown on the "Options" chip. */
export function optionsCount() {
  return avoidedLines().filter((r) => net.lines.some((l) => l.ref === r)).length + (skipBrt() ? 1 : 0) + (skipBus() ? 1 : 0) + (prefsChanged(getPrefs()) ? 1 : 0);
}

let openPanel: "when" | "options" | null = null;
// The choice being made in the time panel. It lives here, not in the panel, so a redraw
// (the street graph arriving, a replan) doesn't throw away a half-made choice.
let draft: { mode: "now" | "depart" | "arrive"; at: string } | null = null;

export function tripControls() {
  const whenPanel = h("div", { class: "trip-panel", hidden: openPanel !== "when" }, whenBody());
  const optPanel = h("div", { class: "trip-panel", hidden: openPanel !== "options" }, optionsBody());
  const chip = (which: "when" | "options", ic: HTMLElement, label: string, on: boolean) => {
    const b = h(
      "button",
      {
        class: `chip-toggle trip-chip${on ? " on" : ""}`,
        "aria-expanded": openPanel === which ? "true" : "false",
        onclick: () => {
          openPanel = openPanel === which ? null : which;
          whenPanel.hidden = openPanel !== "when";
          optPanel.hidden = openPanel !== "options";
          row.querySelectorAll<HTMLElement>(".trip-chip").forEach((c) => c.setAttribute("aria-expanded", c === b && openPanel ? "true" : "false"));
        },
      },
      ic,
      h("span", null, label),
      icon.chevron(),
    );
    return b;
  };
  const n = optionsCount();
  const picked = [
    state.boardStop !== undefined ? pickedChip(t("boardAt", nm(net.stops[state.boardStop].n)), () => (state.boardStop = undefined)) : null,
    state.alightStop !== undefined ? pickedChip(t("alightAt", nm(net.stops[state.alightStop].n)), () => (state.alightStop = undefined)) : null,
  ];
  const row = h(
    "div",
    { class: "trip-chips" },
    chip("when", icon.clock(), whenSummary(), state.when.mode !== "now"),
    chip("options", icon.bus(), n ? t("optionsCount", n) : t("options"), n > 0),
    ...picked,
  );
  return h("div", { class: "trip-controls" }, row, whenPanel, optPanel);
}

// A stop the rider chose, with a cross to let the app choose again.
function pickedChip(label: string, clear: () => void) {
  return h(
    "button",
    {
      class: "chip-toggle trip-chip on",
      "aria-label": `${label} · ${t("close")}`,
      onclick: () => {
        clear();
        plan();
      },
    },
    icon.stop(),
    h("span", null, label),
    icon.close(),
  );
}

// One field for day and time, like a maps app: iPhone shows its date-and-time wheels,
// Android its date then time pickers, a computer a calendar.
const localValue = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function whenBody() {
  const w = state.when;
  const base = w.mode === "now" ? roundUp(new Date()) : new Date(w.at);
  draft ??= { mode: w.mode, at: localValue(base) };
  const d = draft;
  let mode = d.mode;
  const when = h("input", {
    type: "datetime-local",
    class: "time-input",
    "aria-label": t("dayAndTime"),
    value: d.at,
    min: localValue(dayStart(new Date())),
    step: 300,
    oninput: () => (d.at = when.value),
  });
  // What the field holds, in words ("Demain · 07:30"), since the field's own text depends on the phone's settings.
  const said = h("p", { class: "when-said", "aria-live": "polite" });
  const sayIt = () => {
    const v = when.value ? new Date(when.value) : null;
    said.textContent = v && !isNaN(v.getTime()) ? `${dayLabel(v)} · ${clock(v)}` : "";
  };
  when.addEventListener("input", sayIt);
  sayIt();
  const pickers = h("div", { class: "when-pick", hidden: mode === "now" }, h("div", { class: "when-time" }, when, h("button", { class: "btn btn-small btn-primary", onclick: () => apply() }, t("apply"))), said);
  const apply = () => {
    if (mode === "now") state.when = { mode: "now" };
    else {
      const v = new Date(when.value || localValue(base));
      state.when = { mode, at: isNaN(v.getTime()) ? base.getTime() : v.getTime() };
    }
    openPanel = null;
    draft = null;
    plan();
  };
  return h(
    "div",
    null,
    segmented<"now" | "depart" | "arrive">(
      [
        { id: "now", label: t("whenNowShort") },
        { id: "depart", label: t("whenDepart") },
        { id: "arrive", label: t("whenArrive") },
      ],
      mode,
      (id) => {
        mode = id;
        d.mode = id;
        if (id === "now") return apply();
        pickers.hidden = false;
        // Re-mark the segments without rebuilding the panel (keeps the chosen day and time).
        pickers.parentElement?.querySelectorAll<HTMLElement>(".segmented button").forEach((b, i) => {
          const on = ["now", "depart", "arrive"][i] === id;
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
      },
    ),
    pickers,
    h("p", { class: "fine" }, t("whenNote")),
  );
}
const roundUp = (d: Date) => new Date(Math.ceil(d.getTime() / 300_000) * 300_000);

function optionsBody() {
  const avoided = new Set(avoidedLines());
  const replanSoon = () => {
    openPanel = "options";
    plan();
  };
  const lineButtons = net.lines
    .filter((l) => !l.taxi)
    .map((l) =>
      h(
        "button",
        {
          class: `avoid-line${avoided.has(l.ref) ? " off" : ""}`,
          "aria-pressed": avoided.has(l.ref) ? "true" : "false",
          "aria-label": `${l.brt ? t("brt") : l.ref}: ${avoided.has(l.ref) ? t("avoided") : t("allowed")}`,
          onclick: () => {
            if (avoided.has(l.ref)) avoided.delete(l.ref);
            else avoided.add(l.ref);
            setAvoided([...avoided]);
            replanSoon();
          },
        },
        lineBadge(l.brt ? "BHNS" : l.ref, l.colour, "sm"),
        avoided.has(l.ref) ? h("span", { class: "avoid-x", "aria-hidden": "true" }, icon.close()) : null,
      ),
    );
  return h(
    "div",
    null,
    h("h3", { class: "section-title label" }, t("routeTitle")),
    segmented<RoutePref>(
      [
        { id: "best", label: t("routeBest") },
        { id: "changes", label: t("routeChanges") },
        { id: "walk", label: t("routeWalk") },
      ],
      routeOf(getPrefs()),
      (id) => {
        savePrefs({ ...getPrefs(), ...routePrefs(id) });
        openPanel = "options";
        render();
      },
    ),
    h("h3", { class: "section-title label" }, t("modes")),
    h(
      "div",
      { class: "setting-list" },
      settingToggle(t("modeBus"), () => !skipBus(), () => (setMode("skipBus", !skipBus()), replanSoon())),
      settingToggle(t("brt"), () => !skipBrt(), () => (setMode("skipBrt", !skipBrt()), replanSoon())),
    ),
    h("h3", { class: "section-title label" }, t("avoidLinesTitle")),
    h("p", { class: "fine" }, t("avoidLinesHint")),
    h("div", { class: "avoid-grid" }, lineButtons),
    optionsCount()
      ? h(
          "button",
          {
            class: "link",
            onclick: () => {
              setAvoided([]);
              setMode("skipBrt", false);
              setMode("skipBus", false);
              savePrefs({ vot: DEFAULT_VOT, ...routePrefs("best") });
              replanSoon();
            },
          },
          t("resetOptions"),
        )
      : null,
  );
}

/** Pick the stop to walk to (board) or to get off at (alight), like moving the route in a maps app. */
export function pickStopBody(which: "board" | "alight") {
  const end = which === "board" ? state.from : state.to;
  const chosen = which === "board" ? state.boardStop : state.alightStop;
  const pick = (s: number | undefined) => {
    if (which === "board") state.boardStop = s;
    else state.alightStop = s;
    plan();
  };
  const seen = new Set<string>();
  const stops = end
    ? router
        .stopsNear(end.ll, 3500)
        .sort((a, b) => a.crow - b.crow)
        .filter((x) => {
          const k = net.stops[x.stop].n.d ?? String(x.stop);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 30)
    : [];
  return h(
    "div",
    { class: "pick-stop" },
    header(which === "board" ? t("pickBoardTitle") : t("pickAlightTitle"), end ? t(which === "board" ? "nearStart" : "nearEnd", nm(end.label)) : null),
    h(
      "ul",
      { class: "list" },
      h(
        "li",
        null,
        h(
          "button",
          { class: "row", "aria-current": chosen === undefined ? "true" : undefined, onclick: () => pick(undefined) },
          h("span", { class: "row-icon accent" }, icon.check()),
          h("span", { class: "row-main" }, h("span", null, t("letAppChoose"))),
        ),
      ),
      stops.map((x) =>
        h(
          "li",
          null,
          h(
            "button",
            { class: "row", "aria-current": chosen === x.stop ? "true" : undefined, onclick: () => pick(x.stop) },
            h("span", { class: "row-icon" }, icon.stop()),
            h("span", { class: "row-main" }, h("span", null, nm(net.stops[x.stop].n))),
            h("span", { class: "walk-min" }, icon.walk(), fmtMinutes((x.crow * DETOUR) / WALK_SPEED)),
            linesAt(x.stop, 3),
          ),
        ),
      ),
    ),
  );
}
