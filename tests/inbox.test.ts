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
