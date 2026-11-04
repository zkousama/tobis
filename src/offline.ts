import { h } from "./ui/dom.ts";
import type { Key } from "./i18n.ts";

/**
 * Registers the service worker and reports how much of the offline copy is saved.
 * A new version downloads in the background and waits. It takes over right away
 * when `quietMoment()` says so (the app has just opened), otherwise when the
 * rider taps the "new version" message; the page then reloads onto it.
 */
export function registerOffline(onProgress: (done: number, total: number) => void, t: (k: Key) => string, quietMoment: () => boolean) {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  const sw = navigator.serviceWorker;
  const ch = new BroadcastChannel("offline");
  ch.onmessage = (e) => {
    if (e.data?.type === "progress") onProgress(e.data.done, e.data.total);
  };
  // Reload only onto a version this page asked for. The first install also
  // changes the controller (the worker claims the page), and that must not reload.
  let asked = false;
  let reloading = false;
  sw.addEventListener("controllerchange", () => {
    if (!asked || reloading) return;
    reloading = true;
    location.reload();
  });
  const apply = (w: ServiceWorker) => {
    asked = true;
    w.postMessage({ type: "skipWaiting" });
  };
  const offer = (w: ServiceWorker) => {
    if (!sw.controller) return; // first install: nothing to replace
    if (quietMoment()) return apply(w);
    if (document.querySelector(".toast.update")) return;
    document.getElementById("app")?.append(h("button", { class: "toast show update", onclick: () => apply(w) }, t("updated")));
  };
  sw.register(`${import.meta.env.BASE_URL}sw.js`)
    .then(async (reg) => {
      const watch = (w: ServiceWorker | null) =>
        w?.addEventListener("statechange", () => {
          if (w.state === "installed") offer(w);
        });
      if (reg.waiting) offer(reg.waiting);
      watch(reg.installing);
      reg.addEventListener("updatefound", () => watch(reg.installing));
      // An installed app can stay open for days: look again when it comes back, at most hourly.
      let checked = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || Date.now() - checked < 3600_000) return;
        checked = Date.now();
        reg.update().catch(() => {});
      });
      await sw.ready;
      reg.active?.postMessage({ type: "status" });
    })
    .catch(() => {});
}
