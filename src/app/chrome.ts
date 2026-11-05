import { detectLang, setLang, t } from "../i18n.ts";
import { h, icon } from "../ui/dom.ts";
import { current, render, state } from "./state.ts";
import { go, setSheet, userOpenedSheet } from "./nav.ts";
import { locate } from "./location.ts";

// The page's fixed pieces (map, sheet, menu button, locate button, toast),
// the offline download bar, and the snackbar.
setLang(detectLang());
export const app = document.getElementById("app")!;
app.replaceChildren();

// Landmarks, so screen readers can jump between the map and the panel.
export const mapEl = h("div", { id: "map", role: "region", "aria-label": t("mapLabel") });
export const sheetBody = h("div", { class: "sheet-body" });
export const handle = h("button", { class: "sheet-handle", "aria-label": t("sheetResize"), "aria-expanded": "false" });
export const sheet = h("main", { class: "sheet", "data-size": state.sheet }, handle, sheetBody);
// The map gets the screen: one settings button, no title bar.
export const settingsBtn = h("button", { class: "map-btn", onclick: () => go({ name: "about" }) }, icon.menu(), h("span", { class: "map-btn-label" }, t("menuLabel")));
export const topbar = h("header", { class: "topbar" }, settingsBtn);
// While the offline copy downloads: a thin bar along the top of the sheet.
export const progressBar = h("div", { class: "sheet-progress", hidden: true, role: "progressbar", "aria-label": t("downloading") });
sheet.prepend(progressBar);
// No signal: a steady line at the top of the sheet for as long as it lasts.
export const offlineBanner = h("p", { class: "offline-banner", role: "status", hidden: true }, icon.offline(), h("span", null, t("offlineNow")));
sheet.insertBefore(offlineBanner, sheetBody);
export const locateBtn = h("button", { class: "fab fab-locate", "aria-label": t("myLocation"), onclick: () => locate(true) }, icon.locate());
export const toast = h("div", { class: "toast", role: "status" });
app.append(mapEl, topbar, locateBtn, sheet, toast);

// ---------- offline copy ----------
export let offline = { done: 0, total: 0 };
export function onOfflineProgress(done: number, total: number) {
  const wasDownloading = offline.total > 0 && offline.done < offline.total;
  offline = { done, total };
  const complete = done >= total;
  progressBar.hidden = complete;
  progressBar.style.setProperty("--p", `${Math.floor((done / Math.max(1, total)) * 100)}%`);
  // Say it once, when it becomes true; after that it's in Settings.
  if (complete && wasDownloading) flash(t("offlineReady"), 4000);
  if (current().name === "about") render();
}

export let toastTimer = 0;
export function flash(msg: string, ms = 5000) {
  // Like a snackbar: one at a time, just above the sheet.
  const above = innerWidth >= 900 ? 24 : sheet.getBoundingClientRect().height + 12;
  toast.style.bottom = `${above}px`;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), ms);
}

// ---------- bottom sheet drag ----------
{
  let startY = 0;
  let startH = 0;
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = sheet.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    sheet.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    sheet.style.height = `${Math.max(90, Math.min(innerHeight * 0.92, startH + (startY - e.clientY)))}px`;
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("dragging");
    const moved = startY - e.clientY;
    const hgt = sheet.getBoundingClientRect().height / innerHeight;
    sheet.style.height = "";
    if (Math.abs(moved) < 6) setSheet(state.sheet === "peek" ? "half" : state.sheet === "half" ? "full" : "peek");
    else setSheet(hgt > 0.7 ? "full" : hgt > 0.3 ? "half" : "peek");
    if (state.sheet === "full") userOpenedSheet();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
