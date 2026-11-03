import { test } from "node:test";
import assert from "node:assert/strict";
import { RideTracker, type RideUpdate } from "../src/ride.ts";
import { Router, type RideLeg } from "../src/router.ts";
import { dist, type LngLat } from "../src/geo.ts";
import type { Network } from "../src/network.ts";

// One straight eastbound line with stops every ~480 m.
function net(): Network {
  const pts: LngLat[] = [];
  const stops: Network["stops"] = [];
  for (let i = 0; i <= 8; i++) {
    const ll: LngLat = [-9.62 + i * 0.005, 30.4];
    pts.push(ll);
    stops.push({ id: i, ll, n: { d: `S${i}` } });
  }
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + dist(pts[i - 1], pts[i]));
  return {
    city: "t", name: { d: "t" }, bbox: [-10, 30, -9, 31], center: [-9.6, 30.4], zoom: 12, stops, places: [],
    lines: [{ ref: "1", brt: false, name: "1", colour: "#000", variants: [{ rel: 1, from: "S0", to: "S8", shape: pts, stops: stops.map((_, i) => i), along, length: along.at(-1)! }] }],
  };
}

test("ride mode follows the trip: walk, ride, the buzz before the stop, arrival", () => {
  const n = net();
  const origin: LngLat = [-9.6201, 30.4012];
  const dest: LngLat = [-9.5899, 30.4012]; // just past S6
  const [j] = new Router(n).plan(origin, dest);
  const ride = j.legs.find((l): l is RideLeg => l.kind === "ride")!;
  assert.equal(n.stops[n.lines[0].variants[0].stops[ride.alight]].n.d, "S6");

  const updates: RideUpdate[] = [];
  const tr = new RideTracker(n, j, (u) => updates.push(u));
  const at = (lng: number) => tr.update([lng, 30.4], 10);

  tr.update(origin, 10);
  assert.equal(j.legs[updates.at(-1)!.leg].kind, "walk", "starts by walking to the stop");

  at(-9.612); // on the bus between S1 and S2
  let u = updates.at(-1)!;
  assert.equal(j.legs[u.leg].kind, "ride");
  assert.equal(n.stops[u.nextStop!].n.d, "S2");
  assert.equal(u.stopsLeft, 5);

  at(-9.597); // past S4, heading for S5
  assert.equal(updates.at(-1)!.stopsLeft, 2);

  at(-9.5935); // past S5: the next stop is yours
  assert.equal(updates.at(-1)!.stopsLeft, 1);

  at(-9.5901); // at S6
  assert.equal(updates.at(-1)!.stopsLeft, 0);

  at(-9.5880); // walked on past the stop: back to walking
  u = updates.at(-1)!;
  assert.equal(j.legs[u.leg]?.kind ?? "arrived", "walk");
});
