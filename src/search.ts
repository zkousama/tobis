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
  return s
    .replace(/ou/g, "u")
    .replace(/kh/g, "x")
    .replace(/qu|q|ck|c(?![ehiy])/g, "k") // clinique, clinik, klinik sound the same
    .replace(/(.)\1/g, "$1")
    .replace(/^(el|al|l) /, "");
}

/** Optimal string alignment distance (edits, with swaps of neighbours), capped at max+1. */
export function typoDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length];
}

interface Entry {
  hit: Omit<Hit, "score">;
  keys: string[]; // normalized names
  words?: { words: string[]; loose: boolean }[]; // split once, on first search
  typoable?: boolean;
  weight: number;
}

const KIND_WEIGHT: Record<string, number> = { town: 1.3, area: 1.25, airport: 1.3, station: 1.2, school: 1.1, health: 1.1, shop: 1.05, hotel: 0.9, leisure: 1, poi: 0.95 };

export class SearchIndex {
  private entries: Entry[] = [];
  constructor(net: Network) {
    const keysOf = (n: Names) => [...new Set(Object.values(n).filter(Boolean).flatMap((v) => [normalize(v!), loosen(normalize(v!))]))];
    net.places.forEach((p, i) =>
      this.entries.push({ hit: { kind: "place", index: i, label: p.n, sub: p.in !== undefined ? net.places[p.in]?.n : undefined, ll: p.ll, placeKind: p.k }, keys: keysOf(p.n), weight: KIND_WEIGHT[p.k] ?? 1, typoable: ["town", "area", "street", "station", "airport", "health", "school", "gov", "worship"].includes(p.k) }),
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
      this.entries.push({ hit: { kind: "stop", index: i, label: s.n, sub: area, ll: s.ll }, keys: keysOf(s.n), weight: 1.15, typoable: true });
    });
    net.lines.forEach((l, i) =>
      this.entries.push({
        hit: { kind: "line", index: i, label: { d: l.ref }, sub: { d: `${l.variants[0]?.from ?? ""} – ${l.variants[0]?.to ?? ""}` } },
        keys: [normalize(l.ref), normalize(`ligne ${l.ref}`), normalize(`line ${l.ref}`), normalize(`خط ${l.ref}`), ...(l.brt ? ["bhns", "amalway", "trambus", "brt", "ترامبيس"] : [])],
        weight: 1.4,
      }),
    );
  }

  /** Exact and prefix matches first; typo matching only when those find too little. */
  search(query: string, near?: LngLat, limit = 8): Hit[] {
    const hits = this.pass(query, near, limit, false);
    // Typo matching is slower: only when few things matched, and only over
    // the names people mistype most (towns, neighbourhoods, streets, stops).
    if (hits.length >= 3 && hits[0].score >= 0.75) return hits;
    const more = this.pass(query, near, limit, true).filter((h) => !hits.some((x) => x.kind === h.kind && x.index === h.index));
    return [...hits, ...more].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private pass(query: string, near: LngLat | undefined, limit: number, typos: boolean): Hit[] {
    const q = normalize(query);
    if (!q) return [];
    const qTokens = q.split(" ");
    const qLoose = loosen(q).split(" ");
    const out: Hit[] = [];
    for (const e of this.entries) {
      if (typos && !e.typoable) continue;
      let best = 0;
      e.words ??= e.keys.map((k) => ({ words: k.split(" "), loose: k === loosen(k) }));
      for (let ki = 0; ki < e.keys.length; ki++) {
        const key = e.keys[ki];
        const { words, loose } = e.words[ki];
        const tokens = loose ? qLoose : qTokens;
        let score = 0;
        let ok = true;
        for (const tk of tokens) {
          let s = 0;
          for (const w of words) {
            if (w === tk) s = Math.max(s, 1);
            else if (w.startsWith(tk)) s = Math.max(s, 0.75 + 0.25 * (tk.length / w.length));
            else if (tk.length >= 3 && w.includes(tk)) s = Math.max(s, 0.45);
            else if (typos && tk.length >= 4 && w[0] === tk[0]) {
              // A typo: "pharmasie", "inzgan". One edit for short words, two for long ones.
              const max = tk.length >= 7 ? 2 : 1;
              const d = typoDistance(tk, w.slice(0, Math.max(tk.length, Math.min(w.length, tk.length + 1))), max);
              const whole = d <= max ? d : typoDistance(tk, w, max);
              if (Math.min(d, whole) <= max) s = Math.max(s, 0.4 - 0.08 * Math.min(d, whole));
            }
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
