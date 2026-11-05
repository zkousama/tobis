import type { LngLat } from "../geo.ts";
import { fmtDistance, fmtMinutes, fmtStops, t } from "../i18n.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import { fmtDH } from "../fares.ts";
import { net, nm, render, router, state, type Endpoint } from "../app/state.ts";
import { go } from "../app/nav.ts";
import { plan, setEndpoint } from "../app/plan.ts";
import { nextPasses } from "../passes.ts";
import { clock } from "./tripopts.ts";
import { header, linesAt, stopLine } from "./common.ts";

export function linesBody() {
  return h(
    "div",
    { class: "lines" },
    header(t("allLines"), `${net.lines.length} ${t("lines").toLowerCase()}`),
    h(
      "ul",
      { class: "list" },
      net.lines.map((l, li) => {
        const v = l.variants[0];
        const routable = l.variants.some((x) => x.stops.length >= 2);
        const fare = l.fare?.kind === "flat" ? fmtDH(l.fare.normal) : undefined;
        return h(
          "li",
          null,
          h(
            "button",
            { class: "row", onclick: () => go({ name: "line", line: li, variant: 0 }) },
            lineBadge(l.ref, l.colour),
            h("span", { class: "row-main" }, h("span", null, `${v.from} – ${v.to}`), !routable ? h("small", { class: "muted" }, t("pathOnly")) : fare ? h("small", { class: "muted" }, fare) : null),
            icon.chevron(),
          ),
        );
      }),
    ),
  );
}

export function lineBody(li: number, vi: number) {
  const l = net.lines[li];
  const v = l.variants[vi];
  const dirs =
    l.variants.length > 1
      ? h(
          "div",
          { class: "segmented", role: "tablist" },
          l.variants.map((x, i) =>
            h(
              "button",
              {
                class: i === vi ? "on" : "",
                role: "tab",
                "aria-selected": i === vi ? "true" : "false",
                onclick: () => {
                  state.stack[state.stack.length - 1] = { name: "line", line: li, variant: i };
                  render();
                },
                // Screen readers hear "direction Taghazout"; the eye sees the arrow.
                "aria-label": `${t("towards")} ${x.to}`,
              },
              icon.toward(),
              h("span", null, x.to),
            ),
          ),
        )
      : null;
  const facts = [fmtStops(v.stops.length), fmtDistance(v.length), l.headway ? t("noteWait", l.headway) : null, l.fare?.kind === "flat" ? fmtDH(l.fare.normal) : null, l.fare?.kind === "flat" && l.fare.firstCard ? t("cardLine", fmtDH(l.fare.firstCard)) : null].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: "line" },
    header(h("span", { class: "head-line" }, lineBadge(l.ref, l.colour, "lg"), h("span", null, `${v.from} – ${v.to}`)), facts),
    dirs,
    v.inferred ? h("p", { class: "fine", style: "margin:0 0 8px" }, t("orderInferred")) : null,
    v.stops.length < 2
      ? h("p", { class: "notice" }, t("pathOnly"))
      : h(
          "ol",
          { class: "line-stops" },
          v.stops.map((s) => h("li", null, h("button", { class: "row", onclick: () => go({ name: "stop", stop: s }) }, h("span", { class: "row-main" }, h("span", null, nm(net.stops[s].n)), stopLine(s))))),
        ),
  );
}

export function stopBody(si: number) {
  const s = net.stops[si];
  const serving: { li: number; vi: number }[] = [];
  net.lines.forEach((l, li) => l.variants.forEach((v, vi) => v.stops.includes(si) && serving.push({ li, vi })));
  return h(
    "div",
    { class: "stop" },
    header(nm(s.n) || t("stop"), stopLine(si)),
    endpointButtons({ ll: s.ll, label: s.n, kind: "stop" }),
    state.from && state.to
      ? h(
          "div",
          { class: "actions two" },
          h("button", { class: "btn", onclick: () => ((state.boardStop = si), plan()) }, t("getOnHere")),
          h("button", { class: "btn", onclick: () => ((state.alightStop = si), plan()) }, t("getOffHere")),
        )
      : null,
    h("h3", { class: "section-title label" }, t("linesHere")),
    serving.some(({ li }) => net.lines[li].hours) ? h("p", { class: "fine" }, t("passesNote")) : null,
    h(
      "ul",
      { class: "list" },
      serving.map(({ li, vi }) => {
        const l = net.lines[li];
        const v = l.variants[vi];
        // Like a maps app's stop card: the next passages, estimated where the line publishes its times.
        const passes = nextPasses(l, vi, v.stops.indexOf(si), new Date());
        const when = passes.length ? h("small", { class: "stop-passes" }, passes.map(clock).join(" · ")) : h("small", { class: "muted" }, l.headway ? t("noteWait", l.headway) : t("timesNotPublished"));
        return h(
          "li",
          null,
          h(
            "button",
            { class: "row", onclick: () => go({ name: "line", line: li, variant: vi }) },
            lineBadge(l.ref, l.colour),
            h("span", { class: "row-main" }, h("span", null, `${t("towards")} ${v.to}`), when),
            icon.chevron(),
          ),
        );
      }),
    ),
  );
}

export function endpointButtons(ep: Endpoint) {
  return h(
    "div",
    { class: "actions two" },
    h("button", { class: "btn", onclick: () => setEndpoint("from", ep) }, icon.origin(), t("fromHere")),
    h("button", { class: "btn btn-primary", onclick: () => setEndpoint("to", ep) }, icon.dest(), t("toHere")),
  );
}

export function pointBody(ll: LngLat) {
  const near = router.stopsNear(ll, 700);
  const seen = new Set<string>();
  const list = near.filter((x) => {
    const k = net.stops[x.stop].n.d ?? String(x.stop);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 3);
  return h(
    "div",
    { class: "point" },
    header(t("pointOnMap"), list[0] ? `${t("near")} ${nm(net.stops[list[0].stop].n)}` : null),
    endpointButtons({ ll, label: { d: t("pointOnMap") }, kind: "map" }),
    list.length
      ? h(
          "ul",
          { class: "list stop-near" },
          list.map((x) => h("li", null, h("button", { class: "row", onclick: () => go({ name: "stop", stop: x.stop }) }, h("span", { class: "row-icon" }, icon.stop()), h("span", { class: "row-main" }, h("span", null, nm(net.stops[x.stop].n))), h("span", { class: "walk-min" }, icon.walk(), fmtMinutes((x.crow * 1.3) / 1.25)), linesAt(x.stop, 3)))),
        )
      : null,
  );
}
