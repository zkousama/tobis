// Light, dark, or follow the phone. Stored per device.
export type Theme = "auto" | "light" | "dark";
const listeners = new Set<(dark: boolean) => void>();
const media = matchMedia("(prefers-color-scheme: dark)");

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") return t;
  } catch {}
  return "auto";
}
export const isDark = () => (getTheme() === "auto" ? media.matches : getTheme() === "dark");

function apply() {
  const t = getTheme();
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
  const dark = isDark();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#111417" : "#ffffff"));
  listeners.forEach((f) => f(dark));
}
export function setTheme(t: Theme) {
  try {
    if (t === "auto") localStorage.removeItem("theme");
    else localStorage.setItem("theme", t);
  } catch {}
  apply();
}
export function onThemeChange(f: (dark: boolean) => void) {
  listeners.add(f);
}
media.addEventListener("change", () => getTheme() === "auto" && apply());
apply();
