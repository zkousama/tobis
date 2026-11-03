import type { LngLat } from "./geo.ts";
import type { Network, Names } from "./network.ts";

export interface Hit {
  kind: "place" | "stop" | "line";
  index: number;
  label: Names;
  sub?: Names;
  ll?: LngLat;
  score: number;
  placeKind?: string;
}

/** Lowercase, strip accents and Arabic diacritics, unify letter variants. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ً-ٰٟـ]/g, "") // harakat, tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .replace(/['’`´-]/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Common spellings of the same place in Latin script ("ou"/"u", "kh"/"x", doubled letters).
function loosen(s: string): string {
  return s.replace(/ou/g, "u").replace(/kh/g, "x").replace(/(.)\1/g, "$1").replace(/^(el|al|l) /, "");
}

interface Entry {
  hit: Omit<Hit, "score">;
  keys: string[]; // normalized names
  weight: number;
}

const KIND_WEIGHT: Record<string, number> = { town: 1.3, area: 1.25, airport: 1.3, station: 1.2, school: 1.1, health: 1.1, shop: 1.05, hotel: 0.9, leisure: 1, poi: 0.95 };

export class SearchIndex {
  private entries: Entry[] = [];
  constructor(net: Network) {
    const keysOf = (n: Names) => [...new Set(Object.values(n).filter(Boolean).flatMap((v) => [normalize(v!), loosen(normalize(v!))]))];
    net.places.forEach((p, i) =>
      this.entries.push({ hit: { kind: "place", index: i, label: p.n, sub: p.in !== undefined ? net.places[p.in]?.n : undefined, ll: p.ll, placeKind: p.k }, keys: keysOf(p.n), weight: KIND_WEIGHT[p.k] ?? 1 }),
    );
    // Stops with the same name (one per direction) appear once.
    const seen = new Map<string, LngLat[]>();
    net.stops.forEach((s, i) => {
      const name = s.n.d ?? s.n.fr;
      if (!name) return;
      const key = normalize(name);
      const at = seen.get(key) ?? [];
      if (at.some((p) => Math.hypot((p[0] - s.ll[0]) * 96_000, (p[1] - s.ll[1]) * 111_000) < 250)) return;
      seen.set(key, [...at, s.ll]);
      const area = s.area !== undefined ? net.places[s.area]?.n : undefined;
      this.entries.push({ hit: { kind: "stop", index: i, label: s.n, sub: area, ll: s.ll }, keys: keysOf(s.n), weight: 1.15 });
    });
    net.lines.forEach((l, i) =>
      this.entries.push({
        hit: { kind: "line", index: i, label: { d: l.ref }, sub: { d: `${l.variants[0]?.from ?? ""} – ${l.variants[0]?.to ?? ""}` } },
        keys: [normalize(l.ref), normalize(`ligne ${l.ref}`), normalize(`line ${l.ref}`), normalize(`خط ${l.ref}`), ...(l.brt ? ["bhns", "amalway", "trambus", "brt", "ترامبيس"] : [])],
        weight: 1.4,
      }),
    );
  }

  search(query: string, near?: LngLat, limit = 8): Hit[] {
    const q = normalize(query);
    if (!q) return [];
    const qTokens = q.split(" ");
    const qLoose = loosen(q).split(" ");
    const out: Hit[] = [];
    for (const e of this.entries) {
      let best = 0;
      for (const key of e.keys) {
        const words = key.split(" ");
        const tokens = key === loosen(key) ? qLoose : qTokens;
        let score = 0;
        let ok = true;
        for (const tk of tokens) {
          let s = 0;
          for (const w of words) {
            if (w === tk) s = Math.max(s, 1);
            else if (w.startsWith(tk)) s = Math.max(s, 0.75 + 0.25 * (tk.length / w.length));
            else if (tk.length >= 3 && w.includes(tk)) s = Math.max(s, 0.45);
          }
          if (!s) {
            ok = false;
            break;
          }
          score += s;
        }
        if (!ok) continue;
        score /= tokens.length;
        if (key.startsWith(tokens.join(" "))) score += 0.3;
        if (key === tokens.join(" ")) score += 0.3;
        best = Math.max(best, score);
      }
      if (!best) continue;
      let score = best * e.weight;
      if (near && e.hit.ll) {
        const dx = (e.hit.ll[0] - near[0]) * 96, dy = (e.hit.ll[1] - near[1]) * 111; // km
        score *= 1 + 0.6 / (1 + Math.hypot(dx, dy) / 4);
      }
      out.push({ ...e.hit, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
