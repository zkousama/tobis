import { h } from "./ui/dom.ts";
import type { Key } from "./i18n.ts";

/** Registers the service worker and reports how much of the offline copy is saved. */
export function registerOffline(onProgress: (done: number, total: number) => void, t: (k: Key) => string) {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  const show = onProgress;
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
