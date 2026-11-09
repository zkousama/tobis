import type { RideLeg } from "../router.ts";
import { fmtDistance, t } from "../i18n.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import { canSpeak, say, setSpeaking, speaking } from "../speak.ts";
import { RideTracker } from "../ride.ts";
import { bmap, net, nm, ride, setRide, state } from "../app/state.ts";
import { back } from "../app/nav.ts";
import { variantOf } from "./common.ts";

export function rideBody(index: number) {
  const j = state.journeys[index];
  const box = h("div", { class: "ride" });
  const body = h("div", { class: "ride-body" });
  // Spoken announcements: a switch on this screen, remembered; turning it on also says so (which,
  // being a tap, is what lets an iPhone speak later in the ride).
  const voiceBtn = h("button", { class: "btn btn-voice", type: "button" });
  const drawVoice = () => {
    voiceBtn.setAttribute("aria-pressed", speaking() ? "true" : "false");
    voiceBtn.replaceChildren(speaking() ? icon.volume() : icon.volumeOff(), h("span", null, t("voice")));
  };
  voiceBtn.onclick = () => {
    setSpeaking(!speaking());
    drawVoice();
    if (speaking()) say(t("voiceOn"));
  };
  drawVoice();
  box.append(body, h("p", { class: "fine" }, t("rideKeepOpen")), h("div", { class: "actions" }, canSpeak() ? voiceBtn : null, h("button", { class: "btn", onclick: back }, t("stopTrip"))));
  // What was last said, so each announcement is made once.
  let said = "";
  const announce = (key: string, text: string) => {
    if (key === said) return;
    said = key;
    say(text);
  };
  setRide(new RideTracker(net, j, (u) => {
    if (u.me) bmap?.setMe(u.me, u.acc);
    if (u.me && u.follow) bmap?.follow(u.me);
    const leg = j.legs[u.leg];
    let main: Node;
    if (u.status === "nogps") main = h("p", null, t("noGps"));
    else if (!leg) {
      announce("arrived", t("sayArrived"));
      main = h("div", { class: "sign" }, h("div", { class: "sign-row" }, h("span", { class: "sign-text" }, t("arrive"))));
    }
    else if (leg.kind === "walk") {
      const next = j.legs[u.leg + 1] as RideLeg | undefined;
      if (next && u.remaining !== undefined && u.remaining < 40) {
        const nl = net.lines[next.line];
        announce(`board:${u.leg}`, t("sayBoard", nl.brt ? t("brt") : `${t("lineWord")} ${nl.ref}`, variantOf(next).to));
      }
      main = h(
        "div",
        null,
        h("p", { class: "label" }, next ? t("walkTo") : t("walkToDest")),
        h("p", { class: "ride-big" }, next ? nm(net.stops[variantOf(next).stops[next.board]].n) : nm(state.to?.label)),
        h("p", { class: "muted" }, u.remaining !== undefined ? fmtDistance(u.remaining) : t("locating")),
        next && u.remaining !== undefined && u.remaining < 40
          ? h("div", { class: "sign" }, h("div", { class: "sign-row" }, lineBadge(net.lines[next.line].ref, net.lines[next.line].colour, "lg"), h("span", { class: "sign-text" }, variantOf(next).to)), h("div", { class: "sign-sub" }, t("boardHere")))
          : null,
      );
    } else {
      const line = net.lines[leg.line];
      const v = variantOf(leg);
      const left = u.stopsLeft ?? leg.alight - leg.board;
      const alert = left <= 1;
      const off = nm(net.stops[v.stops[leg.alight]].n);
      if (left === 0) announce(`off:${u.leg}`, t("sayGetOffNow", off));
      else if (left === 1) announce(`next-off:${u.leg}`, t("sayGetOffNext", off));
      else if (u.nextStop !== undefined) announce(`next:${u.leg}:${u.nextStop}`, t("sayNext", nm(net.stops[u.nextStop].n)));
      main = h(
        "div",
        null,
        h(
          "div",
          { class: "sign" },
          h("div", { class: "sign-row" }, lineBadge(line.ref, line.colour, "lg"), h("span", { class: "sign-text" }, v.to)),
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
