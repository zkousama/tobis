import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LegTimer } from "../src/triptimes.ts";
// @ts-expect-error: a plain .js Pages Function
import { clean, summarise, onRequestPost, onRequestGet } from "../functions/api/times.js";

// A stop every 400 m; the bus does 6 m/s; a GPS fix every 4 s.
const along = [0, 400, 800, 1200, 1600];
const stops = ["s0", "s1", "s2", "s3", "s4"];
const T0 = new Date("2026-11-09T08:00:00").getTime();

test("a ride's stop-to-stop times and the wait, from GPS fixes", () => {
  const timer = new LegTimer("32", "alsa:L32:outgoing", stops, along, 1, 3);
  timer.atStop(T0); // at stop s1 at 8:00
  for (let t = 0; t <= 120_000; t += 4000) timer.track(400 + ((t % 8000) ? 6 : -6), T0 + t, 10, false); // 2 minutes' wait, GPS drift
  const left = T0 + 124_000;
  for (let t = 0; t <= 300_000; t += 4000) timer.track(400 + (6 * t) / 1000, left + t, 10);
  const r = timer.records();
  const wait = r.find((x) => x.k === "wait")!;
  assert.ok(Math.abs(wait.s - 124) <= 4, `wait ${wait.s}`);
  const hops = r.filter((x) => x.k === "hop");
  assert.deepEqual(hops.map((x) => `${x.a}-${(x as { b: string }).b}`), ["s1-s2", "s2-s3"]); // only between boarding and getting off
  for (const hop of hops) assert.ok(Math.abs(hop.s - 67) <= 5, `hop ${hop.s}`);
  assert.equal(hops[0].h, 8);
});

test("no times from walking along the street, nor from a stop passed before ride mode started", () => {
  const walker = new LegTimer("32", "v", stops, along, 2, 4);
  for (let t = 0; t <= 600_000; t += 4000) walker.track(400 + (1.3 * t) / 1000, T0 + t, 10, false); // walking, never reached the stop
  assert.equal(walker.records().length, 0);
  const late = new LegTimer("32", "v", stops, along, 0, 4);
  for (let t = 0; t <= 200_000; t += 4000) late.track(900 + (6 * t) / 1000, T0 + t, 10); // first fix already past s0..s2
  assert.deepEqual(late.records().map((x) => x.a), ["s3"]); // s3→s4 only: s0 to s2 were passed before the first fix
});

/** Cloudflare D1, enough for the function, on Node's SQLite. */
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001_times.sql", "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: () => db.prepare(sql).run(...(args as [])),
    all: () => ({ results: db.prepare(sql).all(...(args as [])) }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (s: { run: () => unknown }[]) => s.map((x) => x.run()), db };
}

test("the endpoint keeps clean records, drops the rest, and only gives medians where enough rides agree", async () => {
  const env = { DB: d1(), TIMES_KEY: "k3y-for-tests" };
  const get = (key?: string) => onRequestGet({ request: new Request("https://x/api/times", key ? { headers: { authorization: `Bearer ${key}` } } : {}), env });
  const today = new Date();
  const day = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  const hop = (s: number, d: string) => ({ k: "hop", l: "32", v: "alsa:L32:outgoing", a: "70410", b: "70883", s, d, h: 8, w: 1 });
  const items = [hop(60, day(1)), hop(70, day(1)), hop(66, day(2)), hop(64, day(3)), hop(500, day(3)), { ...hop(65, day(1)), ip: "x" }, { ...hop(3, day(1)) }, { ...hop(60, "2020-01-01") }, { k: "hop", l: "32; DROP", v: "x", a: "a", b: "b", s: 60, d: day(1), h: 8, w: 1 }];
  const res = await onRequestPost({ request: new Request("https://x/api/times", { method: "POST", body: JSON.stringify({ v: 1, items }) }), env });
  assert.deepEqual(await res.json(), { kept: 6, dropped: 3 });
  // The extra "ip" field never reaches the table.
  assert.deepEqual(Object.keys(env.DB.db.prepare("SELECT * FROM times LIMIT 1").get()!).sort(), ["a", "b", "day", "dir", "hour", "id", "k", "line", "received", "s", "wday"]);
  // The summary is the owner's: no key or a wrong one gets nothing.
  assert.equal((await get()).status, 401);
  assert.equal((await get("k3y-for-test")).status, 401);
  const sum = await (await get("k3y-for-tests")).json();
  assert.equal(sum.items.length, 1);
  assert.deepEqual({ ...sum.items[0] }, { k: "hop", line: "32", dir: "alsa:L32:outgoing", a: "70410", b: "70883", median: 66, rides: 6, days: 3 }); // 60 64 65 66 70 500: the 500 doesn't drag it
  // Four rides, or rides on two days only, aren't enough.
  assert.equal(summarise([1, 2, 3, 4].map((i) => ({ k: "hop", line: "1", dir: "d", a: "a", b: "b", s: 60, day: day(i) }))).length, 0);
  assert.equal(clean(hop(60, day(30))), null);
});

test("without a database the endpoint says so, and the app keeps its queue", async () => {
  const res = await onRequestPost({ request: new Request("https://x/api/times", { method: "POST", body: "{}" }), env: {} });
  assert.equal(res.status, 503);
});

test("with no key set on the site, nobody can read the summary", async () => {
  const res = await onRequestGet({ request: new Request("https://x/api/times", { headers: { authorization: "Bearer " } }), env: { DB: {} } });
  assert.equal(res.status, 401);
});
