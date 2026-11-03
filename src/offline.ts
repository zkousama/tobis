import { h, icon } from "./ui/dom.ts";
import type { Key } from "./i18n.ts";

/** Registers the service worker and shows download progress, then "ready offline". */
export function registerOffline(chip: HTMLButtonElement, t: (k: Key) => string) {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  const show = (done: number, total: number) => {
    chip.hidden = false;
    if (done >= total) {
      chip.className = "chip chip-offline ready";
      chip.replaceChildren(icon.check(), h("span", null, t("offlineReady")));
      chip.title = t("offlineReady");
      return;
    }
    const pct = Math.floor((done / Math.max(1, total)) * 100);
    chip.className = "chip chip-offline";
    chip.style.setProperty("--p", `${pct}%`);
    chip.replaceChildren(icon.offline(), h("span", null, `${pct}%`));
    chip.title = t("downloading");
  };
  const ch = new BroadcastChannel("offline");
  ch.onmessage = (e) => {
    if (e.data?.type === "progress") show(e.data.done, e.data.total);
  };
  // A new version took over: offer a reload rather than switching data mid-trip.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    const bar = h("button", { class: "toast show update", onclick: () => location.reload() }, t("updated"));
    document.getElementById("app")?.append(bar);
  });
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then(async (reg) => {
      await navigator.serviceWorker.ready;
      reg.active?.postMessage({ type: "status" });
    })
    .catch(() => {});
}
