// Reads the text of an operator post (from an export of the page, or pasted) and drafts the
// claims it seems to make, for a person to check and approve. It never decides anything itself: what
// it finds is a suggestion, and every draft carries the post's link and date as things to fill in.

const strip = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim();

// What a post is about, from its words (French, Darija/Arabic, English).
const KINDS = {
  route: /prolong|extension|nouveau terminus|nouvel itin|itin[ée]raire|d[ée]viation|desserv|terminus|تمديد|مسار|محطة نهائية|extended|reroute/i,
  stopped: /supprim|annul|arr[êe]t de la ligne|n.est plus|remplac|توقيف|إلغاء|withdrawn|discontinued|replaced/i,
  fare: /tarif|prix|ticket|abonnement|ثمن|تعريفة|fare|price/i,
};

/**
 * @param {string} text  the post's text
 * @param {{ lines: string[], stops: string[] }} known  line refs and stop names in the network
 */
export function extract(text, known) {
  const flat = text.replace(/\s+/g, " ");
  // Lines: "ligne 2", "L2", "L-27", "الخط 6", "lignes 2 et 6".
  const refs = new Set();
  for (const m of flat.matchAll(/\b(?:lignes?|lines?|L)\s*-?\s*(\d{1,3}(?:\s*(?:,|et|and|&|و)\s*\d{1,3})*)/gi))
    for (const r of m[1].split(/\s*(?:,|et|and|&|و)\s*/)) refs.add(r.trim());
  for (const m of flat.matchAll(/(?:الخط|الخطوط)\s*(?:رقم\s*)?(\d{1,3})/g)) refs.add(m[1]);
  const lines = [...refs].filter((r) => known.lines.includes(r));

  // Stops named in the post, matched on their normalised names (longest first, so "Fac De Sciences 2"
  // isn't also counted as "Fac De Sciences").
  const hay = ` ${strip(flat)} `;
  const stops = [];
  for (const name of [...new Set(known.stops)].sort((a, b) => b.length - a.length)) {
    const n = strip(name);
    if (n.length < 5) continue;
    if (hay.includes(` ${n} `) && !stops.some((s) => strip(s).includes(n))) stops.push(name);
  }

  // Not \b: it only knows Latin letters, and "5 درهم" ends in Arabic.
  const prices = [...flat.matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:dh|dhs|mad|درهم|دراهم)(?!\p{L})/giu)].map((m) => Number(m[1].replace(",", ".")));
  const dates = [...flat.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/g)].map((m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  const kinds = Object.entries(KINDS)
    .filter(([, re]) => re.test(flat))
    .map(([k]) => k);

  // Draft claims: one per line and kind. Values the text can't give are left as TODO.
  const source = { type: "operator-announcement", name: "ALSA Facebook", date: dates[0] ?? "TODO", url: "TODO" };
  const claims = [];
  for (const ref of lines) {
    if (kinds.includes("stopped")) claims.push({ fact: `line:${ref}:runs`, value: false, kind: "change", source });
    if (kinds.includes("route"))
      claims.push({
        fact: `line:${ref}:route`,
        value: { fr: "TODO: le changement, en une phrase", ar: "TODO", en: "TODO" },
        kind: "change",
        ...(stops.length ? { stops } : {}),
        source,
      });
    if (kinds.includes("fare") && prices.length) claims.push({ fact: `line:${ref}:fare`, value: prices.length === 1 ? prices[0] : "TODO: which price", kind: "change", source });
  }
  if (!lines.length && kinds.includes("fare")) claims.push({ fact: "network:fares", kind: "change", note: `prices seen: ${prices.join(", ") || "none"}`, source });
  return { lines, stops, prices, dates, kinds, claims };
}

/** Anything still to fill in before a draft can join the claims. */
export function todo(claims) {
  return JSON.stringify(claims).match(/TODO[^"]*/g) ?? [];
}
