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
