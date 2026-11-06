import { bmap, ride, state, current, render, type View } from "./state.ts";
import { handle, sheet } from "./chrome.ts";

// ---------- navigation ----------
// Views ride on the browser history, so the phone's back button steps back
// through the app instead of closing it.
export let historyDepth = 1;
export function go(v: View, reset = false) {
  sheetEntry = false;
  if (reset) state.stack = [{ name: "home" }];
  if (v.name !== "home") {
    state.stack.push(v);
    history.pushState({ app: true }, "");
    historyDepth++;
  }
  render();
}
export function back() {
  if (state.stack.length > 1) history.back();
}
addEventListener("popstate", () => {
  historyDepth = Math.max(1, historyDepth - 1);
  if (sheetEntry) {
    sheetEntry = false;
    setSheet("half");
    return;
  }
  if (state.stack.length > 1) state.stack.pop();
  ride?.stop();
  render();
});
/** Replace the view stack (after planning, or picking on the map). */
export function setStack(views: View[]) {
  state.stack = [{ name: "home" }, ...views];
  if (views.length && historyDepth < state.stack.length) {
    history.pushState({ app: true }, "");
    historyDepth++;
  }
}
export function setSheet(size: "peek" | "half" | "full") {
  state.sheet = size;
  sheet.dataset.size = size;
  handle.setAttribute("aria-expanded", size === "full" ? "true" : "false");
  // Wait for the panel's height change to finish, then place the map callouts in the space left.
  setTimeout(() => bmap?.relayoutCallouts(), 320);
}
// A sheet the rider pulled open is a step Back can undo, like a screen.
export let sheetEntry = false;
export function userOpenedSheet() {
  if (sheetEntry || innerWidth >= 900) return;
  sheetEntry = true;
  history.pushState({ app: true, sheet: true }, "");
  historyDepth++;
}
export { current };

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.stack.length > 1) back();
});
