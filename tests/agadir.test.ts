// Checks on the real Agadir build (skipped until `pnpm data` has run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Router, type RideLeg } from "../src/router.ts";
import { parseWalkGraph, Walker } from "../src/walk.ts";
import { dist, type LngLat } from "../src/geo.ts";
import type { Network } from "../src/network.ts";
import { SearchIndex } from "../src/search.ts";

const DATA = "public/data/agadir.json";
const WALK = "public/data/agadir-walk.bin";
const have = existsSync(DATA) && existsSync(WALK);
const net: Network = have ? JSON.parse(readFileSync(DATA, "utf8")) : (null as never);
const walker = have ? new Walker(parseWalkGraph(new Uint8Array(readFileSync(WALK)).buffer)) : (null as never);
const router = have ? new Router(net, walker.walk) : (null as never);

const PLACES: Record<string, LngLat> = {
  marina: [-9.6148, 30.4258],
  taghazout: [-9.7109, 30.5446],
  inezganeSouk: [-9.5363, 30.3557],
  biougra: [-9.3735, 30.2147],
  talborjt: [-9.5985, 30.4245],
  universite: [-9.5445, 30.4045],
};
const refs = (j: { legs: { kind: string }[] }) => j.legs.filter((l): l is RideLeg => l.kind === "ride").map((l) => net.lines[l.line].ref);

test("Marina to Taghazout: a coastal line (32 or 33) heading north", { skip: !have }, () => {
  const js = router.plan(PLACES.marina, PLACES.taghazout);
  const bus = js.filter((j) => j.rides > 0);
  assert.ok(bus.length, "has a bus trip");
  const best = bus[0];
  assert.ok(refs(best).some((r) => r === "32" || r === "33"), `got ${refs(best)}`);
  const leg = best.legs.find((l): l is RideLeg => l.kind === "ride" && ["32", "33"].includes(net.lines[l.line].ref))!;
  const v = net.lines[leg.line].variants[leg.variant];
  assert.ok(net.stops[v.stops[leg.alight]].ll[1] > net.stops[v.stops[leg.board]].ll[1], "rides north");
  assert.ok(dist(net.stops[v.stops[leg.alight]].ll, PLACES.taghazout) < 1200, "gets off near Taghazout");
});

test("Inezgane to Biougra: line 40 or 41", { skip: !have }, () => {
  const js = router.plan(PLACES.inezganeSouk, PLACES.biougra);
  const bus = js.filter((j) => j.rides > 0);
  assert.ok(bus.length);
  assert.ok(bus.some((j) => refs(j).some((r) => r === "40" || r === "41")), JSON.stringify(bus.map(refs)));
});

test("every planned ride goes forward and stays on its line", { skip: !have }, () => {
  const names = Object.keys(PLACES);
  for (const a of names)
    for (const b of names) {
      if (a === b) continue;
      for (const j of router.plan(PLACES[a], PLACES[b])) {
        for (const l of j.legs) if (l.kind === "ride") assert.ok(l.alight > l.board && l.metres > 0, `${a}->${b}`);
        assert.ok(j.seconds > 0 && Number.isFinite(j.seconds));
      }
    }
});

test("street walking is never shorter than a straight line", { skip: !have }, () => {
  const pairs: [LngLat, LngLat][] = [
    [PLACES.marina, PLACES.talborjt],
    [PLACES.talborjt, [-9.5925, 30.4185]],
    [PLACES.universite, [-9.5385, 30.4005]],
  ];
  for (const [a, b] of pairs) {
    const w = walker.walk(a, b);
    assert.ok(w.metres >= dist(a, b) - 1, `${w.metres} vs ${dist(a, b)}`);
    assert.ok(w.metres < dist(a, b) * 2.5, "no absurd detour");
  }
});

test("planning is fast enough for a phone", { skip: !have }, () => {
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) router.plan(PLACES.talborjt, PLACES.inezganeSouk);
  const ms = (performance.now() - t0) / 10;
  assert.ok(ms < 250, `${ms.toFixed(0)} ms per plan`);
});

test("the Trambus carries its card price (bought once) next to the ride fare", { skip: !have }, () => {
  const brt = net.lines.find((l) => l.brt);
  assert.ok(brt?.fare?.kind === "flat");
  assert.equal(brt.fare.normal, 5);
  assert.equal(brt.fare.firstCard, 10);
});

test("leaving the Trambus out still finds buses, with no Trambus ride", { skip: !have }, () => {
  const from = PLACES.talborjt;
  const to: LngLat = [-9.53, 30.395];
  const withBrt = router.plan(from, to);
  assert.ok(withBrt.some((j) => refs(j).includes("BHNS")), "the Trambus is an option on this trip");
  const without = router.plan(from, to, { skipBrt: true });
  assert.ok(without.length > 0);
  for (const j of without) assert.ok(!refs(j).includes("BHNS"));
});

test("search: 'farmacie' finds pharmacies (ph sounds like f)", { skip: !have }, () => {
  const hits = new SearchIndex(net).search("farmacie", PLACES.talborjt, 12);
  assert.ok(hits.some((h) => /pharmacie/i.test(h.label.d ?? "")), "no pharmacy for 'farmacie'");
});

test("trip options: an avoided line is never used", { skip: !have }, () => {
  const to: LngLat = [-9.53, 30.395];
  const five = net.lines.findIndex((l) => l.ref === "5");
  assert.ok(router.plan(PLACES.talborjt, to).some((j) => refs(j).includes("5")), "line 5 is an option on this trip");
  const without = router.plan(PLACES.talborjt, to, { avoid: new Set([five]) });
  assert.ok(without.length > 0);
  for (const j of without) assert.ok(!refs(j).includes("5"));
});

test("trip options: buses off leaves only the Trambus (or walking)", { skip: !have }, () => {
  for (const j of router.plan(PLACES.talborjt, [-9.53, 30.395], { skipBus: true })) for (const r of refs(j)) assert.equal(r, "BHNS");
});

test("trip options: no Trambus before its first departure at 6:00", { skip: !have }, () => {
  const to: LngLat = [-9.53, 30.395];
  const early = new Date(2026, 10, 5, 5, 0);
  const late = new Date(2026, 10, 5, 8, 0);
  assert.ok(!router.plan(PLACES.talborjt, to, { at: early }).some((j) => refs(j).includes("BHNS")), "Trambus at 5:00");
  assert.ok(router.plan(PLACES.talborjt, to, { at: late }).some((j) => refs(j).includes("BHNS")), "no Trambus at 8:00");
});

test("trip options: the rider can walk to a stop of their choice", { skip: !have }, () => {
  const to: LngLat = [-9.53, 30.395];
  const usual = router.plan(PLACES.talborjt, to);
  const firstBoard = (j: { legs: { kind: string }[] }) => {
    const r = j.legs.find((l): l is RideLeg => l.kind === "ride")!;
    return net.lines[r.line].variants[r.variant].stops[r.board];
  };
  const usualStops = new Set(usual.filter((j) => j.rides).map(firstBoard));
  // A stop about 1 km away that the planner doesn't pick by itself.
  const other = router.stopsNear(PLACES.talborjt, 1500).find((x) => x.crow > 700 && !usualStops.has(x.stop))!;
  assert.ok(other, "a farther stop exists");
  const picked = router.plan(PLACES.talborjt, to, { boardStop: other.stop });
  const rides = picked.filter((j) => j.rides);
  assert.ok(rides.length > 0, "trips from the picked stop");
  for (const j of rides) assert.equal(firstBoard(j), other.stop);
});
