import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain .mjs build script, no type declarations
import { decide, deliberate } from "../scripts/council.mjs";

const site = (value: unknown, date = "2026-11-03") => ({ fact: "f", value, source: { type: "operator-site", name: "ALSA site", date } });
const announced = (value: unknown, date: string) => ({ fact: "f", value, kind: "change", source: { type: "press", name: "LesEco", date } });
const rider = (value: unknown, name = "u/someone", date = "2026-11-06") => ({ fact: "f", value, source: { type: "rider", name, date } });

test("an announced change beats a feed that never changed (line 22)", () => {
  const d = decide("line:22:runs", [site(true), announced(false, "2026-05-07")]);
  assert.equal(d.verdict, "apply");
  assert.equal(d.value, false);
  assert.equal(d.dissent.length, 1);
});

test("but not a feed that changed that fact after the announcement", () => {
  const feed = { ...site(true), changedAt: "2026-06-01" };
  const d = decide("f", [feed, announced(false, "2026-05-07")]);
  assert.equal(d.value, true);
});

test("most trusted wins; the press's earlier figure is kept as dissent (Trambus frequency)", () => {
  const d = decide("line:BHNS:headway", [site(10, "2026-11-06"), { ...site(5, "2026-05-07"), source: { type: "press", name: "Morocco World News", date: "2026-05-07" } }]);
  assert.equal(d.value, 10);
  assert.equal(d.dissent[0].value, 5);
});

test("one rider is shown as unconfirmed, never applied", () => {
  const d = decide("line:2:route", [rider("extended to the CHU")]);
  assert.equal(d.verdict, "flag");
  const vsFeed = decide("line:2:fare", [site(4), rider(5)]);
  assert.equal(vsFeed.verdict, "flag");
  assert.equal(vsFeed.value, 5);
});

test("a rider agreeing with a credible source strengthens it", () => {
  const d = decide("line:22:runs", [site(true), announced(false, "2026-05-07"), rider(false)]);
  assert.equal(d.verdict, "apply");
  assert.equal(d.by.length, 2);
});

test("a change with no value goes on watch", () => {
  const d = decide("fares", [{ fact: "fares", source: { type: "press", name: "bladi", date: "2026-01-21" } }]);
  assert.equal(d.verdict, "watch");
});

test("an uncontested feed value is kept", () => {
  const [d] = deliberate([{ ...site(4), fact: "line:5:fare" }]);
  assert.equal(d.verdict, "keep");
  assert.equal(d.value, 4);
});

test("every hand-collected claim names a known kind of source, a name and a date", async () => {
  const { readFileSync } = await import("node:fs");
  // @ts-expect-error: a plain .mjs build script
  const { TRUST } = await import("../scripts/council.mjs");
  const { claims } = JSON.parse(readFileSync("data/council/claims.json", "utf8"));
  for (const c of claims) {
    assert.match(c.fact, /^(line:[A-Z0-9]+:(runs|fare|card|headway|first|last|route|runtime)|network:[a-z]+)$/, `fact "${c.fact}"`);
    assert.ok(c.source.type in TRUST, `${c.fact}: source type "${c.source.type}"`);
    assert.ok(c.source.name && c.source.date, `${c.fact}: source needs a name and a date`);
    // What riders read in the app comes in each language.
    if (c.fact.endsWith(":route")) for (const l of ["fr", "ar", "en"]) assert.ok(c.value?.[l], `${c.fact}: no ${l} text`);
  }
});
