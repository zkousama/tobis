// Line colours come from the operator (ALSA's own colours, Amalway's orange).
// Some are too pale to see on white, so they're darkened just enough, and the
// number on a badge is black or white, whichever reads better.

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0) as [number, number, number];
}
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The colour, darkened until it stands out against `against` (3:1 for lines and shapes). */
export function visible(hex: string, against = "#ffffff", min = 3): string {
  let c = rgb(hex);
  const bg = luminance(against);
  for (let i = 0; i < 30 && contrast(luminance(toHex(c)), bg) < min; i++) c = c.map((v) => (bg > 0.5 ? v * 0.9 : v + (255 - v) * 0.12)) as [number, number, number];
  return toHex(c);
}

/** Text colour for a badge filled with `bg`. */
export const textOn = (bg: string) => (contrast(luminance(bg), 0) > contrast(luminance(bg), 1) ? "#111418" : "#ffffff");
