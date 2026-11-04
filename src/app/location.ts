import type { LngLat } from "../geo.ts";
import { t } from "../i18n.ts";
import { bmap, current, render, state } from "./state.ts";
import { flash, toast } from "./chrome.ts";

// ---------- location ----------
export const LOC_ERRORS = { 1: "locDenied", 2: "locOff", 3: "locTimeout" } as const;
export function locate(fly: boolean, quiet = false): Promise<LngLat | undefined> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      if (!quiet) flash(t("locOff"));
      return resolve(undefined);
    }
    if (fly) flash(t("locating"), 12000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const ll: LngLat = [p.coords.longitude, p.coords.latitude];
        state.me = { ll, acc: p.coords.accuracy, at: Date.now() };
        state.locPerm = "granted";
        bmap?.setMe(ll, p.coords.accuracy);
        if (fly) bmap?.flyTo(ll, 16);
        toast.classList.remove("show");
        if (current().name === "home" || current().name === "search") refreshPlanner();
        resolve(ll);
      },
      (err) => {
        if (err.code === 1) state.locPerm = "denied";
        if (!quiet) flash(t(LOC_ERRORS[err.code as 1 | 2 | 3] ?? "noGps"), 6000);
        resolve(undefined);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}
/** If location is already allowed, find the user quietly so "from" is ready. */
export function watchLocationPermission() {
  if (!navigator.permissions?.query) {
    state.locPerm = "unsupported";
    return;
  }
  navigator.permissions
    .query({ name: "geolocation" })
    .then((p) => {
      state.locPerm = p.state;
      if (p.state === "granted") locate(false, true);
      p.onchange = () => {
        state.locPerm = p.state;
        if (p.state === "granted") locate(false, true);
        if (current().name === "home") render();
      };
      if (current().name === "home") render();
    })
    .catch(() => (state.locPerm = "unsupported"));
}
export let refreshPlanner = () => {};
export const setRefreshPlanner = (f: () => void) => (refreshPlanner = f);
