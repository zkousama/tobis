import { current, render } from "./state.ts";
import { go } from "./nav.ts";

// ---------- installing the app (it's a PWA) ----------
export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export let installEvent: InstallPrompt | undefined;
export const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e as InstallPrompt;
  if (["home", "about", "help"].includes(current().name)) render();
});
addEventListener("appinstalled", () => {
  installEvent = undefined;
  render();
});
export async function install() {
  if (!installEvent) return go({ name: "help", section: "install" });
  await installEvent.prompt();
  await installEvent.userChoice.catch(() => undefined);
  installEvent = undefined;
  render();
}
export const canInstall = () => !standalone() && (!!installEvent || isIos);
