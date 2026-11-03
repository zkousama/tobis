// Checks on the real Agadir build (skipped until `pnpm data` has run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Router, type RideLeg } from "../src/router.ts";
import { parseWalkGraph, Walker } from "../src/walk.ts";
import { dist, type LngLat } from "../src/geo.ts";
import type { Network } from "../src/network.ts";

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
