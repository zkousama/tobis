import { test } from "node:test";
import assert from "node:assert/strict";
import { PaceLearner } from "../src/pace.ts";
import type { LngLat } from "../src/geo.ts";

// ~1.5 m/s east along a street, a fix every 40 s.
const walk = (v: number, n: number, acc = 8): [LngLat, number, number][] =>
  Array.from({ length: n }, (_, i) => [[-9.6 + (v * 40 * i) / 96_000, 30.4] as LngLat, acc, i * 40_000]);

test("learns a brisk walker's pace from good fixes", () => {
  const p = new PaceLearner();
  for (const f of walk(1.5, 8)) p.add(...f);
  assert.ok(Math.abs(p.estimate()! - 1.5) < 0.05, String(p.estimate()));
});

test("ignores bad fixes and vehicle speeds", () => {
  const p = new PaceLearner();
  for (const f of walk(1.5, 8, 60)) p.add(...f); // poor accuracy
  assert.equal(p.estimate(), undefined);
  const q = new PaceLearner();
  for (const f of walk(8, 8)) q.add(...f); // that's a bus, not walking
  assert.equal(q.estimate(), undefined);
});
