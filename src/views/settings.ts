import { getLang, LANGS, setLang, t, type Lang } from "../i18n.ts";
import { h, icon } from "../ui/dom.ts";
import { getTheme, setTheme, type Theme } from "../theme.ts";
import { fmtDH, hasCard, setHasCard } from "../fares.ts";
import { appVersion, bmap, net, offlineMB, render, router, state } from "../app/state.ts";
import { offline } from "../app/chrome.ts";
import { install, installEvent, isIos, standalone } from "../app/install.ts";
import { go } from "../app/nav.ts";
import { skipBrt } from "../app/plan.ts";
import { dataNote, header, segmented, settingToggle } from "./common.ts";

export function installBlock() {
  if (standalone()) return h("p", { class: "notice" }, icon.check(), " ", t("installed"));
  return h(
    "div",
    { class: "install-steps" },
    installEvent ? h("button", { class: "btn btn-primary", onclick: install }, icon.offline(), t("installNow")) : h("p", null, isIos ? t("helpInstallIos") : t("helpInstallAndroid")),
    offlineMB ? h("small", { class: "muted" }, t("offlineSize", offlineMB)) : null,
  );
}

export function trambusSettings(): Node[] {
  const brt = net.lines.find((l) => l.brt);
  if (!brt) return [];
  const f = brt.fare?.kind === "flat" ? brt.fare : undefined;
  return [
    h("h3", { class: "section-title label" }, t("brt")),
    h(
      "div",
      { class: "setting-chips" },
      f?.firstCard ? settingToggle(t("haveCardSetting"), () => hasCard(brt.ref), () => setHasCard(brt.ref, !hasCard(brt.ref))) : null,
      settingToggle(
        t("skipBrt"),
        skipBrt,
        () => {
          try {
            localStorage.setItem("skipBrt", skipBrt() ? "0" : "1");
          } catch {}
          if (state.from && state.to) state.journeys = router.plan(state.from.ll, state.to.ll, { skipBrt: skipBrt() });
        },
      ),
    ),
    f?.firstCard ? h("p", { class: "fine" }, t("cardFirst", fmtDH(f.firstCard), fmtDH(f.normal))) : null,
  ].filter(Boolean) as Node[];
}

export function aboutBody() {
  return h(
    "div",
    { class: "about" },
    header(t("settings")),
    h("h3", { class: "section-title label" }, t("language")),
    segmented(
      LANGS.map((l) => ({ id: l.id, label: l.label, lang: l.id === "ar" ? "ar-MA" : l.id })),
      getLang(),
      (id) => {
        setLang(id as Lang);
        bmap?.setLang(id);
        render();
      },
    ),
    h("h3", { class: "section-title label" }, t("appearance")),
    segmented<Theme>(
      [
        { id: "auto", label: t("themeAuto") },
        { id: "light", label: t("themeLight") },
        { id: "dark", label: t("themeDark") },
      ],
      getTheme(),
      (id) => {
        setTheme(id);
        render();
      },
    ),
    ...trambusSettings(),
    h("h3", { class: "section-title label" }, t("helpOfflineTitle")),
    h("p", { class: "notice" }, offline.total && offline.done >= offline.total ? [icon.check(), " ", t("offlineReady")] : offline.total ? `${t("downloading")} · ${Math.floor((offline.done / offline.total) * 100)} %` : t("helpOffline")),
    h("h3", { class: "section-title label" }, t("helpInstallTitle")),
    installBlock(),
    h("button", { class: "cta", onclick: () => go({ name: "help" }) }, h("span", { class: "plus" }, "?"), t("helpLink")),
    h("p", null, t("aboutText")),
    dataNote(),
    h("p", { class: "fine" }, [t("dataAlsa"), t("dataAmalway"), t("dataOverture")].join(" · ")),
    h(
      "p",
      { class: "fine" },
      h("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" }, "© OpenStreetMap contributors"),
      " · ",
      h("a", { href: "https://docs.overturemaps.org/attribution/", target: "_blank", rel: "noopener" }, "Overture Maps Foundation"),
      " · ",
      h("a", { href: "https://protomaps.com", target: "_blank", rel: "noopener" }, "Protomaps"),
      " · ",
      h("a", { href: "https://github.com/zkousama/tobis", target: "_blank", rel: "noopener" }, "GitHub"),
    ),
    appVersion ? h("p", { class: "fine" }, t("version", appVersion)) : null,
  );
}
