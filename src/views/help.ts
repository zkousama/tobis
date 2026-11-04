import { t } from "../i18n.ts";
import { h, icon } from "../ui/dom.ts";
import { net } from "../app/state.ts";
import { pasteFromClipboard } from "../app/plan.ts";
import { cardNote, header } from "./common.ts";
import { installBlock } from "./settings.ts";

/** What the app does, what it doesn't, and how to get round the gaps. */
export function helpBody(section?: string) {
  const sec = (id: string, title: string, ...body: Node[]) => h("section", { class: "help-section", id: `help-${id}` }, h("h3", { class: "step-title" }, title), ...body);
  const list = (keys: Parameters<typeof t>[0][], cls = "help-list") => h("ul", { class: cls }, keys.map((k) => h("li", null, t(k))));
  const el = h(
    "div",
    { class: "help" },
    header(t("help")),
    sec("what", t("helpWhatTitle"), list(["helpWhat1", "helpWhat2", "helpWhat3", "helpWhat4"])),
    sec("cant", t("helpCantTitle"), list(["helpCant1", "helpCant2", "helpCant3", "helpCant4"], "help-list help-cant")),
    sec(
      "find",
      t("helpFindTitle"),
      h("ol", { class: "help-steps" }, (["helpFind1", "helpFind2", "helpFind3", "helpFind4"] as const).map((k) => h("li", null, t(k)))),
      h("p", { class: "tl-note" }, icon.info(), h("span", null, t("helpFindNote"))),
      h("button", { class: "btn btn-small", onclick: () => pasteFromClipboard("to") }, icon.link(), t("pasteLink")),
    ),
    ...net.lines
      .filter((l) => l.fare?.kind === "flat" && l.fare.firstCard)
      .map((l) => {
        const f = l.fare as { normal: number; firstCard: number };
        const box = h("div", null);
        const fill = () => box.replaceChildren(cardNote(l.ref, f.firstCard, f.normal, fill));
        fill();
        return sec("card", t("helpCardTitle"), box);
      }),
    sec("install", t("helpInstallTitle"), installBlock()),
    sec("offline", t("helpOfflineTitle"), h("p", null, t("helpOffline"))),
    sec("location", t("helpLocTitle"), h("p", null, t("helpLoc"))),
  );
  if (section) queueMicrotask(() => el.querySelector(`#help-${section}`)?.scrollIntoView({ block: "start" }));
  return el;
}
