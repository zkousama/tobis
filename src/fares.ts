import type { Line, Network, Variant } from "./network.ts";
import type { Journey, RideLeg } from "./router.ts";

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
    const cards = Object.values(f.card);
    return prices.length ? { normal: Math.min(...prices), card: cards.length ? Math.min(...cards) : undefined } : undefined;
  }
  const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
  return f.normal[key] !== undefined ? { normal: f.normal[key], card: f.card[key] } : undefined;
}

/**
 * What a trip costs: each ride's fare, except a change the operator lets you make on the same ticket
 * (8B ⇄ Trambus at the Port, within the hour). Undefined when a ride's price isn't published.
 */
export function tripFare(net: Network, j: Journey): number | undefined {
  let total = 0;
  let prev: { leg: RideLeg; boardedAt: number } | undefined;
  let clock = 0; // seconds since the start of the trip
  for (const l of j.legs) {
    if (l.kind === "walk") {
      clock += l.seconds;
      continue;
    }
    clock += l.wait;
    const line = net.lines[l.line];
    const at = line.variants[l.variant].stops[l.board];
    const free =
      prev &&
      net.transfers?.some((t) => {
        const pair = [net.lines[prev!.leg.line].ref, line.ref];
        return t.lines.includes(pair[0]) && t.lines.includes(pair[1]) && pair[0] !== pair[1] && t.at.includes(at) && clock - prev!.boardedAt <= t.within * 60;
      });
    const boardedAt = clock;
    clock += l.seconds;
    if (free) {
      prev = undefined; // the ticket covers one change
      continue;
    }
    const f = fareFor(line, line.variants[l.variant], l.board, l.alight);
    if (!f) return undefined;
    total += f.normal;
    prev = { leg: l, boardedAt };
  }
  return total || undefined;
}

// Wrapped in a left-to-right isolate so "≈ 5 DH" keeps its order inside Arabic text.
export const fmtDH = (n: number) => `\u2066${n % 1 ? n.toFixed(2).replace(/0$/, "") : n} DH\u2069`;
