import { t } from "../i18n.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import { net, nm, offlineMB, render, state } from "../app/state.ts";
import { canInstall, install } from "../app/install.ts";
import { go } from "../app/nav.ts";
import { locate } from "../app/location.ts";
import { recents, setEndpoint } from "../app/plan.ts";
import { dataNote } from "./common.ts";

export function homeBody() {
  const rec = recents();
  const brt = net.lines.findIndex((l) => l.brt);
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("installDismissed") === "1";
  } catch {}
  const cards: Node[] = [];
  // Location: ask once, with a reason, rather than a surprise browser prompt.
  if (!state.me && state.locPerm !== "granted")
    cards.push(
      h(
        "button",
        { class: "tip", onclick: () => locate(true) },
        h("span", { class: "row-icon accent" }, icon.locate()),
        h("span", { class: "row-main" }, h("strong", null, t("useMyLocation")), h("small", { class: "muted" }, state.locPerm === "denied" ? t("locDenied") : t("useMyLocationSub"))),
      ),
    );
  let tripsSeen = 0;
  try {
    tripsSeen = Number(localStorage.getItem("tripsSeen")) || 0;
  } catch {}
  // Offer the install after the app has been useful once, never on first open.
  if (canInstall() && !dismissed && tripsSeen > 0)
    cards.push(
      h(
        "div",
        { class: "tip tip-install" },
        h("span", { class: "row-icon" }, icon.offline()),
        h("span", { class: "row-main" }, h("strong", null, t("installCard")), offlineMB ? h("small", { class: "muted" }, t("offlineSize", offlineMB)) : null),
        h("button", { class: "btn btn-small btn-primary", onclick: install }, t("installNow")),
        h(
          "button",
          {
            class: "link",
            onclick: () => {
              try {
                localStorage.setItem("installDismissed", "1");
              } catch {}
              render();
            },
          },
          t("later"),
        ),
      ),
    );
  return h(
    "div",
    { class: "home" },
    cards.length ? h("div", { class: "tips" }, cards) : null,
    h(
      "div",
      { class: "quick" },
      brt >= 0
        ? h(
            "button",
            { class: "quick-card quick-brt", onclick: () => go({ name: "line", line: brt, variant: 0 }) },
            lineBadge("BHNS", net.lines[brt].colour),
            h("span", { class: "serif" }, `${net.lines[brt].variants[0].from} – ${net.lines[brt].variants[0].to}`),
            net.lines[brt].headway ? h("small", null, t("noteWait", net.lines[brt].headway)) : null,
          )
        : null,
      h(
        "button",
        { class: "quick-card", onclick: () => go({ name: "lines" }) },
        h("span", { class: "row-icon" }, icon.bus()),
        h("span", { class: "serif" }, t("allLines")),
        h("small", null, `${net.lines.length} ${t("lines").toLowerCase()}`),
      ),
    ),
    rec.length
      ? h(
          "div",
          { class: "section" },
          h("h3", { class: "section-title label" }, t("recent")),
          h(
            "ul",
            { class: "list" },
            rec.map((ep) =>
              h(
                "li",
                null,
                h("button", { class: "row", onclick: () => setEndpoint("to", ep) }, h("span", { class: "row-icon" }, icon.clock()), h("span", { class: "row-main" }, h("span", null, nm(ep.label)), ep.sub ? h("small", { class: "muted" }, nm(ep.sub)) : null)),
              ),
            ),
          ),
        )
      : null,
    h("button", { class: "cta", onclick: () => go({ name: "help" }) }, h("span", { class: "plus" }, "?"), t("helpLink")),
    dataNote(),
  );
}
