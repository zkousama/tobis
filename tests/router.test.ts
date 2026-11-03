import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, type RideLeg } from "../src/router.ts";
import { dist, type LngLat } from "../src/geo.ts";
import type { Network, Variant } from "../src/network.ts";

// Line A runs east along lat 30.40 (both directions); line B runs north along lon -9.57.
function variant(stopIdx: number[], pts: LngLat[], from: string, to: string): Variant {
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + dist(pts[i - 1], pts[i]));
  return { rel: 0, from, to, shape: pts, stops: stopIdx, along: along.map(Math.round), length: along.at(-1)! };
}
function makeNet(): Network {
  const stops: Network["stops"] = [];
  const add = (ll: LngLat, name: string) => (stops.push({ id: stops.length, ll, n: { d: name } }), stops.length - 1);
  const aPts: LngLat[] = [];
  const a: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const ll: LngLat = [-9.62 + i * 0.005, 30.4];
    aPts.push(ll);
    a.push(add(ll, `A${i}`));
  }
  const bPts: LngLat[] = [];
  const b: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const ll: LngLat = [-9.5951, 30.38 + i * 0.005]; // crosses A near A5 (lon -9.595)
    bPts.push(ll);
    b.push(add(ll, `B${i}`));
  }
  return {
    city: "test", name: { d: "Test" }, bbox: [-10, 30, -9, 31], center: [-9.6, 30.4], zoom: 12,
    stops, places: [],
    lines: [
      { ref: "A", brt: false, name: "A", colour: "#f00", variants: [variant(a, aPts, "A0", "A10"), variant([...a].reverse(), [...aPts].reverse(), "A10", "A0")] },
      { ref: "B", brt: false, name: "B", colour: "#00f", variants: [variant(b, bPts, "B0", "B8")] },
    ],
  };
}
const rides = (j: { legs: { kind: string }[] }) => j.legs.filter((l): l is RideLeg => l.kind === "ride");

test("direct trip uses the eastbound direction and the right stops", () => {
  const net = makeNet();
  const r = new Router(net);
  const [best] = r.plan([-9.6201, 30.4002], [-9.5699, 30.3998]);
  const legs = rides(best);
  assert.equal(legs.length, 1);
  const v = net.lines[legs[0].line].variants[legs[0].variant];
  assert.equal(v.to, "A10");
  assert.equal(net.stops[v.stops[legs[0].board]].n.d, "A0");
  assert.equal(net.stops[v.stops[legs[0].alight]].n.d, "A10");
});

test("the opposite trip takes the westbound direction", () => {
  const net = makeNet();
  const [best] = new Router(net).plan([-9.5699, 30.4], [-9.6201, 30.4]);
  const legs = rides(best);
  assert.equal(net.lines[legs[0].line].variants[legs[0].variant].to, "A0");
});

test("a trip across both lines changes at the crossing", () => {
  const net = makeNet();
  const js = new Router(net).plan([-9.6201, 30.4], [-9.5951, 30.4201]);
  const best = js[0];
  const legs = rides(best);
  assert.deepEqual(legs.map((l) => net.lines[l.line].ref), ["A", "B"]);
  const off = net.stops[net.lines[legs[0].line].variants[legs[0].variant].stops[legs[0].alight]];
  const on = net.stops[net.lines[legs[1].line].variants[legs[1].variant].stops[legs[1].board]];
  assert.ok(dist(off.ll, on.ll) < 400, "the change is a short walk");
  assert.equal(net.stops[net.lines[legs[1].line].variants[legs[1].variant].stops[legs[1].alight]].n.d, "B8");
});

test("every ride goes forward along its line", () => {
  const net = makeNet();
  const r = new Router(net);
  for (const [o, d] of [
    [[-9.62, 30.4], [-9.57, 30.4]],
    [[-9.57, 30.4], [-9.5951, 30.42]],
    [[-9.5951, 30.38], [-9.62, 30.4]],
  ] as [LngLat, LngLat][])
    for (const j of r.plan(o, d)) for (const l of rides(j)) assert.ok(l.alight > l.board);
});

test("short trips offer walking", () => {
  const js = new Router(makeNet()).plan([-9.62, 30.4], [-9.61, 30.4]);
  assert.ok(js.some((j) => j.rides === 0));
});

test("nothing nearby gives no bus trips", () => {
  const js = new Router(makeNet()).plan([-9.2, 30.1], [-9.25, 30.15]);
  assert.equal(js.filter((j) => j.rides > 0).length, 0);
});

test("a ride never crosses an untrusted section", () => {
  const net = makeNet();
  net.lines[0].variants[0].breaks = [4]; // A4 -> A5 is in doubt
  const js = new Router(net).plan([-9.6201, 30.4], [-9.5699, 30.4]);
  for (const j of js)
    for (const l of rides(j)) {
      if (net.lines[l.line].ref !== "A" || l.variant !== 0) continue;
      assert.ok(l.alight <= 4 || l.board >= 5, `rode ${l.board}->${l.alight}`);
    }
});
