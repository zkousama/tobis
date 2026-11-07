// The data council: every fact about the network (a line runs, its fare, how often it comes, where
// it ends) is a claim from a source, and the council decides which to believe, with reasons.
//
// Why: no single source is right. ALSA's site still listed line 22 months after the Trambus replaced
// it; press coverage gave the Trambus "every 5 minutes" before Amalway settled on 10; riders know
// about new terminals before any feed does. So each claim carries its source type, a date and a link,
// and these rules decide:
//
//  1. Trust tiers. An operator announcement (a post on the operator's page, a communiqué) outranks the
//     operator's site, which outranks OpenStreetMap and the press, which outrank a single rider.
//  2. A feed that never changed is not newer evidence. A site's listing is the state it was set up
//     with, so an announced change (trust >= press) beats it unless the feed changed that fact after
//     the announcement.
//  3. Between state claims, the most trusted wins, then the newest; claims that disagree are kept as
//     dissent and published.
//  4. Riders alone never change the data. One report is shown in the app as "unconfirmed"; it applies
//     only once a source of press level or above agrees.
//  5. A claim without a value ("fares went up", amounts unknown) is put on watch: listed in the
//     report, not shown in the app.
//
// The verdicts: "apply" (the build uses the value), "flag" (shown in the app as unconfirmed, with its
// source), "watch" (report only), "keep" (nothing contests the feed).

export const TRUST = { "operator-announcement": 5, "operator-site": 4, press: 3, osm: 3, rider: 1 };
const PRESS = TRUST.press;

/**
 * @typedef {{ type: keyof typeof TRUST, name: string, url?: string, date: string }} Source
 * @typedef {{ fact: string, value?: unknown, kind?: "state" | "change", changedAt?: string, source: Source, note?: string }} Claim
 * @typedef {{ fact: string, verdict: "apply" | "flag" | "watch" | "keep", value?: unknown, by: Claim[], dissent: Claim[], reason: string }} Decision
 */

const trust = (c) => TRUST[c.source.type] ?? 0;
const day = (s) => (s ? Date.parse(s) : NaN);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Newer first; undated last.
const byDate = (a, b) => (day(b.source.date) || 0) - (day(a.source.date) || 0);

/** Decide one fact from its claims. */
export function decide(fact, claims) {
  const valued = claims.filter((c) => c.value !== undefined);
  const watch = claims.filter((c) => c.value === undefined);
  if (!valued.length) return { fact, verdict: "watch", by: watch, dissent: [], reason: "a change is reported but without the new value" };

  const strong = valued.filter((c) => trust(c) >= PRESS);
  const riders = valued.filter((c) => trust(c) < PRESS);

  // Rule 2: the newest announced change by a credible source, against feeds that didn't change after it.
  const change = strong.filter((c) => c.kind === "change").sort(byDate)[0];
  if (change) {
    const feedsAfter = strong.filter((c) => c.kind !== "change" && !same(c.value, change.value) && c.changedAt && day(c.changedAt) > day(change.source.date));
    if (!feedsAfter.length) {
      const agree = valued.filter((c) => same(c.value, change.value));
      return {
        fact,
        verdict: "apply",
        value: change.value,
        by: agree,
        dissent: valued.filter((c) => !same(c.value, change.value)),
        reason: `announced change (${change.source.name}, ${change.source.date}) and no feed changed this after it`,
      };
    }
  }

  // Rule 3: most trusted, then newest, among credible claims.
  if (strong.length) {
    const top = [...strong].sort((a, b) => trust(b) - trust(a) || byDate(a, b))[0];
    const agree = valued.filter((c) => same(c.value, top.value));
    const dissent = valued.filter((c) => !same(c.value, top.value));
    const ridersAgainst = dissent.filter((c) => trust(c) < PRESS);
    // Rule 4: riders disagreeing with the feeds are shown, not applied.
    if (ridersAgainst.length && !dissent.some((c) => trust(c) >= PRESS)) {
      return {
        fact,
        verdict: "flag",
        value: ridersAgainst[0].value,
        by: ridersAgainst,
        dissent: agree,
        reason: `${ridersAgainst.length === 1 ? "one rider reports" : `${ridersAgainst.length} riders report`} a change no credible source confirms yet`,
      };
    }
    const reason =
      agree.length > 1
        ? `${agree.length} sources agree${dissent.length ? `; ${dissent.length} disagree with less trust or older dates` : ""}`
        : dissent.length
          ? `most trusted source (${top.source.name}); ${dissent.length} disagree with less trust or older dates`
          : `only source (${top.source.name})`;
    return { fact, verdict: dissent.length || agree.length > 1 || top.kind === "change" ? "apply" : "keep", value: top.value, by: agree, dissent, reason };
  }

  // Riders only.
  const names = new Set(riders.map((c) => c.source.name));
  return { fact, verdict: "flag", value: riders[0].value, by: riders, dissent: [], reason: `${names.size === 1 ? "one rider reports it" : `${names.size} riders report it`}, unconfirmed` };
}

/** Group claims by fact and decide each. */
export function deliberate(claims) {
  const byFact = new Map();
  for (const c of claims) {
    if (!byFact.has(c.fact)) byFact.set(c.fact, []);
    byFact.get(c.fact).push(c);
  }
  return [...byFact].map(([fact, cs]) => decide(fact, cs));
}

/** The published record: what was decided, from what, and what lost. */
export function report(decisions) {
  const line = (c) => `${c.source.name} (${c.source.type}, ${c.source.date})${c.source.url ? ` <${c.source.url}>` : ""}${c.note ? `: ${c.note}` : ""}`;
  const contested = decisions.filter((d) => d.verdict !== "keep");
  const md = [
    "# Data council",
    "",
    "Generated by `scripts/build-data.mjs` from the claims in `data/council/claims.json` and the operator feeds. The rules are at the top of `scripts/council.mjs`.",
    "",
    `${decisions.length} facts: ${decisions.filter((d) => d.verdict === "keep").length} uncontested, ${decisions.filter((d) => d.verdict === "apply").length} decided, ${decisions.filter((d) => d.verdict === "flag").length} shown as unconfirmed, ${decisions.filter((d) => d.verdict === "watch").length} on watch.`,
    "",
    ...contested.flatMap((d) => [
      `## ${d.fact}: ${d.verdict}${d.value !== undefined ? ` → \`${JSON.stringify(d.value)}\`` : ""}`,
      "",
      `${d.reason[0].toUpperCase()}${d.reason.slice(1)}.`,
      "",
      ...d.by.map((c) => `- for: ${line(c)}`),
      ...d.dissent.map((c) => `- against: ${line(c)} → \`${JSON.stringify(c.value)}\``),
      "",
    ]),
  ];
  return md.join("\n");
}
