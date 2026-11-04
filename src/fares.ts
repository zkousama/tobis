import type { Line, Variant } from "./network.ts";

export interface Fare {
  normal: number;
  card?: number; // with the operator's card (Ikhlas for ALSA)
  firstCard?: number; // a card you must buy before the first ride (the Trambus)
}

/** Lines you can only ride with a card bought once; the rider can say they have it. */
export function hasCard(ref: string): boolean {
  try {
    return localStorage.getItem(`card:${ref}`) === "1";
  } catch {
    return false;
  }
}
export function setHasCard(ref: string, yes: boolean) {
  try {
    localStorage.setItem(`card:${ref}`, yes ? "1" : "0");
  } catch {}
}

/** Ticket price for riding a line between two stops, when the operator publishes it. */
export function fareFor(line: Line, v: Variant, board: number, alight: number): Fare | undefined {
  const f = line.fare;
  if (!f) return undefined;
  if (f.kind === "flat") return { normal: f.normal, card: f.card, firstCard: f.firstCard };
  const z = v.zones;
  if (!z) return undefined;
  const a = z[board], b = z[alight];
  if (a === b) {
    // Same zone: the cheapest published price is the closest we have.
    const prices = Object.values(f.normal);
    return prices.length ? { normal: Math.min(...prices), card: Math.min(...Object.values(f.card)) } : undefined;
  }
  const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
  return f.normal[key] !== undefined ? { normal: f.normal[key], card: f.card[key] } : undefined;
}

// Wrapped in a left-to-right isolate so "≈ 5 DH" keeps its order inside Arabic text.
export const fmtDH = (n: number) => `\u2066${n % 1 ? n.toFixed(2).replace(/0$/, "") : n} DH\u2069`;
