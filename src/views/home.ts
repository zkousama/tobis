import { t } from "../i18n.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import { net, nm, offlineMB, render, state } from "../app/state.ts";
import { canInstall, install } from "../app/install.ts";
import { go } from "../app/nav.ts";
import { locate } from "../app/location.ts";
import { planUsual, recents, setEndpoint, usualTrips } from "../app/plan.ts";
import { dataNote } from "./common.ts";

export function homeBody() {
  const rec = recents();
  const brt = net.lines.findIndex((l) => l.brt);
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("installDismissed") === "1";
  } catch {}
  // One look for everything under the search field: rows, like the search list.
  const row = (onclick: () => void, lead: Node, main: (Node | null)[], end: Node | null = icon.chevron()) =>
    h("li", null, h("button", { class: "row", onclick }, lead, h("span", { class: "row-main" }, ...main), end));

  // Location: asked once, with a reason, rather than a surprise browser prompt.
  const locRow =
    !state.me && state.locPerm !== "granted"
      ? h("ul", { class: "list" }, row(() => locate(true), h("span", { class: "row-icon accent" }, icon.locate()), [h("span", null, t("useMyLocation")), state.locPerm === "denied" ? h("small", { class: "muted" }, t("locDenied")) : null], null))
      : null;

  let tripsSeen = 0;
  try {
    tripsSeen = Number(localStorage.getItem("tripsSeen")) || 0;
  } catch {}
  // Offered after the app has been useful once, never on first open. Dismissed for good with the cross.
  const installBanner =
    canInstall() && !dismissed && tripsSeen > 0
      ? h(
          "div",
          { class: "install-banner" },
          h("span", { class: "row-main" }, h("strong", null, t("installCard")), offlineMB ? h("small", { class: "muted" }, t("installSub", offlineMB)) : null),
          h("button", { class: "btn btn-small btn-primary", onclick: install }, t("installNow")),
          h(
            "button",
            {
              class: "icon-btn",
              "aria-label": t("later"),
              onclick: () => {
                try {
                  localStorage.setItem("installDismissed", "1");
                } catch {}
                render();
              },
            },
            icon.close(),
          ),
        )
      : null;

  const brtLine = brt >= 0 ? net.lines[brt] : undefined;
  const usual = usualTrips();
  return h(
    "div",
    { class: "home" },
    locRow,
    installBanner,
    usual.length
      ? h(
          "div",
          { class: "section" },
          h("h3", { class: "section-title label" }, t("usualTrips")),
          h(
            "ul",
            { class: "list usual" },
            usual.map((u) =>
              row(() => planUsual(u), h("span", { class: "row-icon accent" }, icon.bus()), [
                h("span", null, nm(u.to.label)),
                h("small", { class: "muted" }, `${t("fromWord")} ${u.from.kind === "me" ? t("whereIAm") : nm(u.from.label)}`),
              ]),
            ),
          ),
        )
      : null,
    rec.length
      ? h(
          "div",
          { class: "section" },
          h("h3", { class: "section-title label" }, t("recent")),
          h(
            "ul",
            { class: "list" },
            rec.map((ep) => row(() => setEndpoint("to", ep), h("span", { class: "row-icon" }, icon.clock()), [h("span", null, nm(ep.label)), ep.sub ? h("small", { class: "muted" }, nm(ep.sub)) : null], null)),
          ),
        )
      : null,
    h(
      "div",
      { class: "section" },
      h("h3", { class: "section-title label" }, t("lines")),
      h(
        "ul",
        { class: "list" },
        brtLine
          ? row(() => go({ name: "line", line: brt, variant: 0 }), lineBadge("BHNS", brtLine.colour), [
              h("span", null, `${brtLine.variants[0].from} – ${brtLine.variants[0].to}`),
              brtLine.headway ? h("small", { class: "muted" }, t("noteWait", brtLine.headway)) : null,
            ])
          : null,
        row(() => go({ name: "lines" }), h("span", { class: "row-icon" }, icon.bus()), [h("span", null, t("allLines")), h("small", { class: "muted" }, `${net.lines.length} ${t("lines").toLowerCase()}`)]),
      ),
    ),
    h("button", { class: "cta", onclick: () => go({ name: "help" }) }, h("span", { class: "plus" }, "?"), t("helpLink")),
    dataNote(),
  );
}
