import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePlusCode, parseInput, parseMapsUrl, recoverPlusCode } from "../src/geoinput.ts";
import { dist, type LngLat } from "../src/geo.ts";

const AGADIR: LngLat = [-9.58, 30.41];
const near = (a: LngLat | undefined, b: LngLat, m = 30) => a !== undefined && dist(a, b) < m;

test("full plus code decodes to its centre", () => {
  // The example from the Open Location Code docs (Zurich).
  const ll = decodePlusCode("8FVC9G8F+6X");
  assert.ok(near(ll, [8.5249375, 47.3655625], 5), String(ll));
});

test("short plus code is recovered near Agadir", () => {
  // Greater Agadir's codes start with 8C2G; Google shows them without it locally.
  const full = "8C2GC9FP+83";
  const fullLL = decodePlusCode(full)!;
  const short = recoverPlusCode("C9FP+83", AGADIR);
  assert.ok(near(short, fullLL, 2), `${short} vs ${fullLL}`);
  assert.ok(dist(fullLL, AGADIR) < 40_000);
});

test("Google Maps place link: the pin wins over the viewport", () => {
  const p = parseMapsUrl("https://www.google.com/maps/place/Cabinet+Dentaire/@30.4100000,-9.5900000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d30.4123456!4d-9.5987654");
  assert.deepEqual(p.ll, [-9.5987654, 30.4123456]);
  assert.equal(p.name, "Cabinet Dentaire");
});

test("query and @ links", () => {
  assert.deepEqual(parseMapsUrl("https://maps.google.com/?q=30.4,-9.6").ll, [-9.6, 30.4]);
  assert.deepEqual(parseMapsUrl("https://www.google.com/maps/@30.42,-9.61,15z").ll, [-9.61, 30.42]);
});

test("short links are flagged for expanding", () => {
  assert.equal(parseMapsUrl("https://maps.app.goo.gl/AbCdEf123").shortUrl, "https://maps.app.goo.gl/AbCdEf123");
});

test("shared text keeps the place name before the link", () => {
  const p = parseInput("Dr. Example, Cardiologue\nhttps://maps.app.goo.gl/AbCdEf123", AGADIR);
  assert.equal(p.shortUrl, "https://maps.app.goo.gl/AbCdEf123");
  assert.equal(p.name, "Dr. Example, Cardiologue");
});

test("geo URIs, plain coordinates and plus codes in text", () => {
  assert.deepEqual(parseInput("geo:30.41,-9.59?q=Clinique", AGADIR).ll, [-9.59, 30.41]);
  assert.deepEqual(parseInput("30.4123, -9.5987", AGADIR).ll, [-9.5987, 30.4123]);
  assert.ok(parseInput("Code: C9FP+83 Agadir", AGADIR).ll);
  assert.equal(parseInput("pharmacie", AGADIR).ll, undefined);
});
