import { test } from "node:test";
import assert from "node:assert/strict";
import { RangeOrWholeSource } from "../src/tilesource.ts";

const FILE = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));

function mockFetch(honourRange: boolean) {
  let calls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls++;
    const range = new Headers(init?.headers).get("range");
    const m = range && /bytes=(\d+)-(\d+)/.exec(range);
    if (honourRange && m) return new Response(FILE.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
    return new Response(FILE, { status: 200 });
  }) as typeof fetch;
  return () => calls;
}

const bytes = async (src: RangeOrWholeSource, o: number, l: number) => [...new Uint8Array((await src.getBytes(o, l)).data)];

test("a host that honours ranges is asked for each piece", async () => {
  const calls = mockFetch(true);
  const src = new RangeOrWholeSource("https://x/map.pmtiles");
  assert.deepEqual(await bytes(src, 10, 4), Array.from(FILE.slice(10, 14)));
  assert.deepEqual(await bytes(src, 500, 3), Array.from(FILE.slice(500, 503)));
  assert.equal(calls(), 2);
});

test("a host that sends the whole file is downloaded once, then sliced", async () => {
  const calls = mockFetch(false);
  const src = new RangeOrWholeSource("https://x/map.pmtiles");
  assert.deepEqual(await bytes(src, 0, 5), Array.from(FILE.slice(0, 5)));
  assert.deepEqual(await bytes(src, 990, 10), Array.from(FILE.slice(990, 1000)));
  assert.deepEqual(await bytes(src, 123, 7), Array.from(FILE.slice(123, 130)));
  assert.equal(calls(), 1);
});
