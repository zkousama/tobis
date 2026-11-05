import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, winners, type Option } from "../src/compare.ts";

const opt = (kind: Option["kind"], min: number, cost: number | undefined, walk: number): Option => ({
  kind,
  seconds: min * 60,
  cost: cost === undefined ? undefined : { low: cost, high: cost },
  walkMetres: walk,
  parts: [],
  range: [min * 60, min * 60],
});
const bus = opt("transit", 34, 2.5, 600);
const tram = opt("transit", 24, 5, 380);
const taxi = opt("petitTaxi", 16, 15, 0);
const unknownFare = opt("transit", 30, undefined, 300);
const all = [bus, tram, taxi, unknownFare];

test("fastest first", () => assert.deepEqual(rank(all, "fast").map((o) => o.seconds / 60), [16, 24, 30, 34]));

test("cheapest first; unpublished fares go last", () => {
  const r = rank(all, "cheap");
  assert.equal(r[0], bus);
  assert.equal(r.at(-1), unknownFare);
});

test("least walking first; ties broken by speed", () => {
  const r = rank([bus, opt("petitTaxi", 20, 18, 0), taxi], "walk");
  assert.equal(r[0], taxi);
});

test("one winner per measure", () => {
  const w = winners(all);
  assert.equal(w.fast, taxi);
  assert.equal(w.cheap, bus);
  assert.equal(w.walk, taxi);
});

test("an option worse on time, price and walking is dropped", async () => {
  const { paretoFront } = await import("../src/compare.ts");
  const good = { ...opt("transit", 20, 4, 300), range: [0, 0] as [number, number] };
  const worse = { ...opt("transit", 35, 4, 700), range: [0, 0] as [number, number] };
  const taxi = { ...opt("petitTaxi", 12, 15, 0), range: [0, 0] as [number, number] };
  const front = paretoFront([good, worse, taxi]);
  assert.deepEqual(front, [good, taxi]);
});

test("generalised cost: a little cheaper isn't worth a lot slower, unless time is cheap", async () => {
  const { recommend } = await import("../src/compare.ts");
  const parts = (ride: number, walk: number, wait: number) => [
    { k: "walk" as const, s: walk * 60 },
    { k: "wait" as const, s: wait * 60 },
    { k: "ride" as const, s: ride * 60 },
  ];
  const tram = { ...opt("transit", 24, 5, 380), parts: parts(14, 5, 5) };
  const bus = { ...opt("transit", 34, 2.5, 900), parts: parts(12, 12, 10) };
  assert.equal(recommend([bus, tram], { vot: 0.3, walkWeight: 1.5 })[0], tram); // 2.5 DH isn't worth 10 min
  assert.equal(recommend([bus, tram], { vot: 0.03, walkWeight: 1.5 })[0], bus); // on a tight budget it is
});

test("choices nudge the value of time, a third of the way", async () => {
  const { learnVot, recommend } = await import("../src/compare.ts");
  const parts = (ride: number, walk: number, wait: number) => [
    { k: "walk" as const, s: walk * 60 },
    { k: "wait" as const, s: wait * 60 },
    { k: "ride" as const, s: ride * 60 },
  ];
  const tram = { ...opt("transit", 24, 5, 380), parts: parts(14, 5, 5) };
  const bus = { ...opt("transit", 34, 2.5, 900), parts: parts(12, 12, 10) };
  const p = { vot: 0.3, walkWeight: 1.5 };
  assert.equal(recommend([bus, tram], p)[0], tram);
  const v1 = learnVot(bus, [bus, tram], p); // picked the cheap bus anyway
  assert.ok(v1 < 0.3 && v1 > 0.05, String(v1));
  assert.equal(learnVot(tram, [bus, tram], p), 0.3); // picked what we recommended: no change
});

test("route preference 'fewer changes' puts a direct trip ahead of a slightly faster one with a change", async () => {
  const { generalisedCost } = await import("../src/compare.ts");
  const part = (k: "ride" | "walk" | "wait", min: number) => ({ k, s: min * 60 });
  const direct: Option = { kind: "transit", seconds: 40 * 60, range: [40 * 60, 40 * 60], cost: { low: 4, high: 4 }, walkMetres: 300, parts: [part("walk", 4), part("wait", 5), part("ride", 31)] };
  const oneChange: Option = { kind: "transit", seconds: 34 * 60, range: [34 * 60, 34 * 60], cost: { low: 4, high: 4 }, walkMetres: 300, parts: [part("walk", 4), part("wait", 3), part("ride", 12), part("wait", 3), part("ride", 12)] };
  const best = { vot: 0.15, walkWeight: 1.5, changeMinutes: 5 };
  const fewer = { ...best, changeMinutes: 20 };
  assert.ok(generalisedCost(oneChange, best) < generalisedCost(direct, best), "normally the faster trip with a change wins");
  assert.ok(generalisedCost(direct, fewer) < generalisedCost(oneChange, fewer), "with 'fewer changes' the direct trip wins");
});
