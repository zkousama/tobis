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
  assert.equal(brt.fare.firstCard, 5); // "le prix de la carte + 1 voyage à 10 Dhs", the trip being 5
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

test("far from any stop: no bus within the usual walk, buses once the walk is wider", { skip: !have }, () => {
  // A spot whose nearest stop is 1.5 to 3 km away (outskirts), going to the centre.
  let spot: LngLat | undefined;
  for (let lng = -9.75; lng < -9.3 && !spot; lng += 0.01)
    for (let lat = 30.25; lat < 30.6 && !spot; lat += 0.01) {
      const p: LngLat = [lng, lat];
      const nearest = Math.min(...router.stopsNear(p, 4000).map((x) => x.crow));
      if (nearest > 1500 && nearest < 3000) spot = p;
    }
  assert.ok(spot, "no outskirts spot found");
  const usual = router.plan(spot!, PLACES.talborjt);
  assert.ok(!usual.some((j) => j.rides > 0), "a bus within the usual walk");
  const wide = router.plan(spot!, PLACES.talborjt, { maxAccess: 4000 });
  assert.ok(wide.some((j) => j.rides > 0), "no bus even with a 4 km walk");
});

test("every line's badge text reads at 4.5:1 or more (WCAG AA, small text)", { skip: !have }, async () => {
  const { badgeColours, luminance, visible } = await import("../src/ui/colour.ts");
  for (const l of net.lines) {
    const { bg, text } = badgeColours(visible(l.colour ?? "#555555", "#ffffff", 1.6));
    const [a, b] = [luminance(bg), luminance(text)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(ratio >= 4.5, `line ${l.ref} (${l.colour}): ${ratio.toFixed(2)}:1`);
  }
});

test("Trambus passing times at a stop: from 06:00 plus the ride there, every 10 minutes", { skip: !have }, async () => {
  const { nextPasses } = await import("../src/passes.ts");
  const brt = net.lines.find((l) => l.brt)!;
  const v = brt.variants[0];
  const mid = Math.floor(v.stops.length / 2);
  const early = nextPasses(brt, 0, mid, new Date(2026, 10, 6, 4, 0));
  assert.equal(early.length, 3);
  assert.ok(early[0].getHours() === 6, `first pass at ${early[0]}`);
  assert.equal((early[1].getTime() - early[0].getTime()) / 60000, brt.headway);
  const later = nextPasses(brt, 0, mid, new Date(2026, 10, 6, 10, 3));
  assert.ok(later[0].getTime() >= new Date(2026, 10, 6, 10, 3).getTime(), "a pass in the past");
  assert.ok(later[0].getTime() - new Date(2026, 10, 6, 10, 3).getTime() <= brt.headway! * 60000, "next pass more than one gap away");
  const bus = net.lines.find((l) => !l.brt && !l.hours)!;
  assert.deepEqual(nextPasses(bus, 0, 1, new Date()), [], "a bus without published times gets none");
});

test("each line's two directions head to different places (ALSA copies the outbound names onto the return)", { skip: !have }, () => {
  for (const l of net.lines) {
    if (l.variants.length < 2) continue;
    const tos = l.variants.map((v) => v.to);
    assert.equal(new Set(tos).size, tos.length, `line ${l.ref}: ${tos.join(" / ")}`);
  }
});

test("ALSA hours: only line 26's look real (06:30-21:00, every 30 min), so it's off the table at 01:30", { skip: !have }, async () => {
  const { runsAt } = await import("../src/router.ts");
  const withHours = net.lines.filter((l) => !l.brt && l.hours).map((l) => l.ref);
  assert.deepEqual(withHours, ["26"]);
  const l26 = net.lines.find((l) => l.ref === "26")!;
  assert.deepEqual(l26.hours, { first: "06:30", last: "21:00" });
  assert.equal(l26.headway, 30);
  assert.ok(runsAt(l26.hours, 10 * 60), "runs at 10:00");
  assert.ok(!runsAt(l26.hours, 90), "runs at 01:30");
  assert.ok(!runsAt(l26.hours, 21 * 60 + 30), "runs at 21:30");
});

test("departure timed to the walk: leave so you reach the stop as the Trambus comes", { skip: !have }, async () => {
  const { departFor } = await import("../src/depart.ts");
  const from = new Date(2026, 10, 6, 10, 3);
  const trips = router.plan(PLACES.talborjt, [-9.53, 30.395], { at: from });
  const brtTrip = trips.find((j) => refs(j)[0] === "BHNS");
  assert.ok(brtTrip, "a Trambus trip");
  const d = departFor(net, brtTrip!, from);
  assert.ok(d.catchAt, "a timed passage");
  assert.ok(Math.abs(d.leave.getTime() + d.walkSeconds * 1000 - d.catchAt!.getTime()) < 1000, "leave + walk = the passage");
  assert.ok(d.leave.getTime() >= from.getTime(), "never leave in the past");
  assert.ok(d.catchAt!.getTime() - (from.getTime() + d.walkSeconds * 1000) < 10 * 60_000, "the first passage you can reach, not a later one");
  assert.ok(d.arrive > d.catchAt!);
  const busTrip = trips.find((j) => j.rides > 0 && !net.lines[(j.legs.find((l) => l.kind === "ride") as RideLeg).line].hours);
  if (busTrip) {
    const b = departFor(net, busTrip, from);
    assert.equal(b.catchAt, undefined, "no invented time for a bus without timetable");
    assert.equal(b.leave.getTime(), from.getTime());
  }
});

test("line 22 is gone: the Trambus replaced it in May 2026, though ALSA's site still lists it", { skip: !have }, () => {
  assert.ok(!net.lines.some((l) => l.ref === "22"));
});

test("fares follow ALSA's grid of 19 January 2026, zone lines included", { skip: !have }, async () => {
  const { fareFor } = await import("../src/fares.ts");
  const line = (ref: string) => net.lines.find((l) => l.ref === ref)!;
  assert.deepEqual(line("1").fare, { kind: "flat", normal: 4 }); // the feed has no price for line 1
  assert.deepEqual(line("6").fare, { kind: "flat", normal: 4, transfer: 1 });
  const f31 = line("31").fare;
  assert.ok(f31?.kind === "zones");
  assert.deepEqual(f31.normal, { "0-1": 5, "0-2": 6, "1-2": 6 });
  // The old card prices went with the old grid; a same-zone ride still gets a price.
  const v = line("31").variants.find((x) => x.zones)!;
  const k = v.zones!.findIndex((z, i) => i > 0 && z === v.zones![i - 1]);
  assert.equal(fareFor(line("31"), v, k - 1, k)?.normal, 5);
});

test("an announced route change already drawn isn't flagged; one drawn from the announcement says so", { skip: !have }, () => {
  const line = (ref: string) => net.lines.find((l) => l.ref === ref)!;
  assert.equal(line("2").notices, undefined); // the Aït Taoukt terminus is in ALSA's data
  assert.equal(line("27").notices, undefined); // so is the CHU
  assert.deepEqual(line("6").notices?.map((n) => n.what), ["drawn"]);
});

test("routes ALSA announced but its site doesn't show are drawn, and say so", { skip: !have }, () => {
  const line = (ref: string) => net.lines.find((l) => l.ref === ref);
  const names = (ref: string) => new Set(line(ref)!.variants.flatMap((v) => v.stops.map((i) => net.stops[i].n.d)));
  // New lines: 8B ends at the Trambus's Port station (the transfer), 342 at Amskroud and Tikiouine.
  assert.ok(names("8B").has("Port") && names("8B").has("Taddart 1"));
  assert.ok(names("342").has("Cité des Métiers") && names("342").has("Terminus Amskroud poste"));
  // Extensions to the CHU, and line 31's new way through Anza (its old loop by the coast is gone).
  for (const ref of ["1", "6"]) assert.ok(line(ref)!.variants.every((v) => v.stops.some((i) => net.stops[i].n.d === "Terminus CHU")), `line ${ref}`);
  assert.ok(names("31").has("Souk Anza") && !names("31").has("Les Huileries Souss"));
  // The app says it's drawn from the announcement, with the stops nobody has placed yet.
  const note = line("8B")!.notices?.find((n) => n.what === "drawn");
  assert.ok(note?.missing?.some((m) => m.fr === "Hay Harrouchi"));
  assert.equal(line("2")!.notices, undefined);
});

test("Inezgane to the CHU: line 6 goes there now", { skip: !have }, () => {
  const chu = net.stops.find((s) => s.n.d === "Terminus CHU")!.ll;
  const js = router.plan(PLACES.inezganeSouk, chu);
  assert.ok(js.some((j) => refs(j).includes("6")), `got ${js.map((j) => refs(j).join("+")).join(", ")}`);
});

test("every stop is in the city, and no line is drawn far off its stops", { skip: !have }, () => {
  const [w, s, e, n] = net.bbox;
  for (const st of net.stops) assert.ok(st.ll[0] > w && st.ll[0] < e && st.ll[1] > s && st.ll[1] < n, `${st.n.d} at ${st.ll}`);
  for (const l of net.lines)
    for (const v of l.variants) {
      let crow = 0;
      for (let k = 1; k < v.stops.length; k++) crow += dist(net.stops[v.stops[k - 1]].ll, net.stops[v.stops[k]].ll);
      // Streets wind, one-way loops add some; a line many times longer than its stops is drawn wrong.
      assert.ok(v.length < crow * 2.5 + 5000, `line ${l.ref} ${v.from} → ${v.to}: ${Math.round(v.length / 1000)} km for ${Math.round(crow / 1000)} km of stops`);
    }
});

test("the Trambus end to end takes the published 45 minutes, not the street-bus estimate", { skip: !have }, async () => {
  const { rideClock } = await import("../src/router.ts");
  const brt = net.lines.find((l) => l.brt)!;
  assert.equal(brt.runtime, 45);
  for (const v of brt.variants) assert.equal(Math.round(rideClock(v.along, brt.runtime).at(-1)! / 60), 45);
  // A bus line without a published time keeps the estimate.
  const v12 = net.lines.find((l) => l.ref === "12")!.variants[0];
  assert.ok(rideClock(v12.along)[1] > 0);
});

test("Trambus then 8B at the Port within the hour is one ticket (ALSA, 13 October 2026)", { skip: !have }, async () => {
  const { tripFare } = await import("../src/fares.ts");
  const li = (ref: string) => net.lines.findIndex((l) => l.ref === ref);
  const brt = li("BHNS"), b8 = li("8B");
  const vToPort = net.lines[brt].variants.findIndex((v) => net.stops[v.stops.at(-1)!].n.d === "Port");
  const v8 = net.lines[b8].variants.findIndex((v) => net.stops[v.stops[0]].n.d === "Port");
  const vb = net.lines[brt].variants[vToPort], w8 = net.lines[b8].variants[v8];
  const ride = (line: number, variant: number, board: number, alight: number, seconds: number, wait: number) => ({ kind: "ride" as const, line, variant, board, alight, metres: 1000, seconds, wait });
  const trip = (gap: number) => ({ legs: [ride(brt, vToPort, vb.stops.length - 6, vb.stops.length - 1, 600, 120), ride(b8, v8, 0, w8.stops.length - 1, 900, gap)] }) as never;
  assert.equal(tripFare(net, trip(300)), 5); // the 8B leg rides on the Trambus ticket
  // Past the hour, the second ticket is due: 8B's price isn't published, so the total is unknown.
  assert.equal(tripFare(net, trip(3600)), undefined);
  // Two Trambus rides aren't a change between the two lines.
  assert.equal(tripFare(net, { legs: [ride(brt, vToPort, 0, 3, 300, 60), ride(brt, vToPort, 5, 8, 300, 60)] } as never), 10);
});
