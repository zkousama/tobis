import type { RideLeg } from "../router.ts";
import { fmtDistance, t } from "../i18n.ts";
import { h } from "../ui/dom.ts";
import { RideTracker } from "../ride.ts";
import { bmap, net, nm, ride, setRide, state } from "../app/state.ts";
import { back } from "../app/nav.ts";
import { variantOf } from "./common.ts";

export function rideBody(index: number) {
  const j = state.journeys[index];
  const box = h("div", { class: "ride" });
  const body = h("div", { class: "ride-body" });
  box.append(body, h("p", { class: "fine" }, t("rideKeepOpen")), h("div", { class: "actions" }, h("button", { class: "btn", onclick: back }, t("stopTrip"))));
  setRide(new RideTracker(net, j, (u) => {
    if (u.me) bmap?.setMe(u.me, u.acc);
    if (u.me && u.follow) bmap?.follow(u.me);
    const leg = j.legs[u.leg];
    let main: Node;
    if (u.status === "nogps") main = h("p", null, t("noGps"));
    else if (!leg) main = h("div", { class: "sign" }, h("div", { class: "sign-row" }, h("span", { class: "sign-text" }, t("arrive"))));
    else if (leg.kind === "walk") {
      const next = j.legs[u.leg + 1] as RideLeg | undefined;
      main = h(
        "div",
        null,
        h("p", { class: "label" }, next ? t("walkTo") : t("walkToDest")),
        h("p", { class: "ride-big" }, next ? nm(net.stops[variantOf(next).stops[next.board]].n) : nm(state.to?.label)),
        h("p", { class: "muted" }, u.remaining !== undefined ? fmtDistance(u.remaining) : t("locating")),
        next && u.remaining !== undefined && u.remaining < 40
          ? h("div", { class: "sign" }, h("div", { class: "sign-row" }, h("span", { class: "sign-num" }, net.lines[next.line].brt ? "T" : net.lines[next.line].ref), h("span", { class: "sign-text" }, variantOf(next).to)), h("div", { class: "sign-sub" }, t("boardHere")))
          : null,
      );
    } else {
      const line = net.lines[leg.line];
      const v = variantOf(leg);
      const left = u.stopsLeft ?? leg.alight - leg.board;
      const alert = left <= 1;
      main = h(
        "div",
        null,
        h(
          "div",
          { class: "sign" },
          h("div", { class: "sign-row" }, h("span", { class: "sign-num" }, line.brt ? "T" : line.ref), h("span", { class: "sign-text" }, v.to)),
          u.nextStop !== undefined ? h("div", { class: "sign-sub" }, `${t("nextIs")} · ${nm(net.stops[u.nextStop].n)}`) : null,
        ),
        h(
          "div",
          { class: alert ? "ride-alert" : "" },
          alert
            ? h("p", { class: "ride-big" }, left === 0 ? t("getOffNow") : t("getOffNext"))
            : h("p", { class: "ride-big" }, h("span", { class: "num" }, String(left)), h("small", null, t("stopsLeft"))),
          h("p", null, `${t("getOff")} `, h("strong", { class: "marked" }, nm(net.stops[v.stops[leg.alight]].n))),
        ),
      );
    }
    body.replaceChildren(main);
  }));
  ride!.start();
  return box;
}
