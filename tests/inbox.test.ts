import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain .mjs build script
import { extract, todo } from "../scripts/inbox-extract.mjs";

const known = { lines: ["2", "6", "8", "27", "BHNS"], stops: ["Terminus CHU", "Taoukt terminus", "Fac De Sciences", "Fac De Sciences 2", "Anza"] };

test("a French post about a route change: lines, stops, date, a route claim to complete", () => {
  const post = "Chers clients, à partir du 15/03/2026 les lignes 2 et 6 sont prolongées jusqu'au Terminus CHU, en passant par Taoukt terminus.";
  const r = extract(post, known);
  assert.deepEqual(r.lines, ["2", "6"]);
  assert.deepEqual(r.stops.sort(), ["Taoukt terminus", "Terminus CHU"]);
  assert.deepEqual(r.dates, ["2026-03-15"]);
  assert.ok(r.kinds.includes("route"));
  assert.equal(r.claims.length, 2);
  assert.equal(r.claims[0].source.date, "2026-03-15");
  assert.ok(todo(r.claims).length > 0, "the link and the wording still need a person");
});

test("an Arabic post about a fare: the line and its new price", () => {
  const r = extract("إخبار: ابتداء من اليوم ثمن التذكرة في الخط 27 هو 5 درهم", known);
  assert.deepEqual(r.lines, ["27"]);
  assert.deepEqual(r.prices, [5]);
  assert.deepEqual(r.claims.map((c: { fact: string; value: unknown }) => [c.fact, c.value]), [["line:27:fare", 5]]);
});

test("a withdrawn line, and a stop name inside a longer one isn't counted twice", () => {
  const r = extract("La ligne L8 est supprimée. Desserte de Fac De Sciences 2 assurée par la ligne 27.", known);
  assert.deepEqual(r.stops, ["Fac De Sciences 2"]);
  assert.ok(r.claims.some((c: { fact: string; value: unknown }) => c.fact === "line:8:runs" && c.value === false));
});

test("lines that don't exist in the network are ignored", () => {
  assert.deepEqual(extract("ligne 999 et ligne 2", known).lines, ["2"]);
});

test("an Amalway post is about the Trambus unless it names a line", () => {
  const known = { lines: ["BHNS", "8B", "6"], stops: [] };
  assert.deepEqual(extract("Nouveaux horaires à partir du 01/12/2026 : premier départ à 05:30", known, "Amalway Facebook").lines, ["BHNS"]);
  assert.equal(extract("Nouveaux horaires", known, "Amalway Facebook").claims.length, 0);
  assert.deepEqual(extract("Correspondance ligne 8B et Trambus au Port", known, "ALSA Facebook").lines.sort(), ["8B", "BHNS"]);
});

test("Facebook reads go in three-month windows, and keep a post's permanent link", async () => {
  // @ts-expect-error: a plain .mjs script
  const { windows, keep } = await import("../scripts/fetch-facebook.mjs");
  const w = windows(new Date("2026-01-01T00:00:00Z"), new Date("2026-11-08T12:00:00Z"));
  assert.deepEqual(w[0], { from: "2026-08-09", to: "2026-11-09" });
  assert.equal(w.at(-1).from, "2026-01-01");
  assert.equal(w.length, 4);
  const p = keep({ postId: "1536171421888126", facebookId: "100064858474347", url: "https://www.facebook.com/x/posts/pfbid0abc?x=1", time: "2026-10-12T18:36:13.000Z", text: "t", topComments: [{ profileName: "someone" }] }, "ALSA Facebook");
  assert.equal(p.url, "https://www.facebook.com/100064858474347/posts/1536171421888126");
  assert.equal(JSON.stringify(p).includes("someone"), false);
});

test("line refs with a letter, and ALSA's L-numbers, in French and Arabic", () => {
  const known = { lines: ["8B", "342", "31", "BHNS"], stops: [] };
  assert.deepEqual(extract("الخط 8B يغير مساره", known).lines, ["8B"]);
  assert.deepEqual(extract("Lancement de la ligne L342 et de la ligne 31", known).lines.sort(), ["31", "342"]);
  assert.deepEqual(extract("خط جديد L342 بين أمسكرود وتيكيوين", known).lines, ["342"]);
});
