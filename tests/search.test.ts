import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, SearchIndex } from "../src/search.ts";
import type { Network } from "../src/network.ts";

const net = {
  city: "t", name: { d: "T" }, bbox: [0, 0, 1, 1], center: [0, 0], zoom: 12,
  stops: [
    { id: 1, ll: [-9.6, 30.4], n: { d: "Hôpital Hassan II" } },
    { id: 2, ll: [-9.6, 30.4], n: { d: "Hôpital Hassan II" } },
    { id: 3, ll: [-9.55, 30.33], n: { d: "Place d'Inezgane" } },
  ],
  places: [
    { ll: [-9.6, 30.42], n: { d: "Talborjt", ar: "تالبرجت" }, k: "area" },
    { ll: [-9.55, 30.35], n: { d: "Inezgane", ar: "إنزكان" }, k: "town" },
  ],
  lines: [{ ref: "32", brt: false, name: "Bus 32", colour: "#000", variants: [{ rel: 1, from: "Agadir", to: "Taghazout", shape: [], stops: [], along: [], length: 0 }] }],
} as unknown as Network;

test("normalize strips accents, apostrophes and Arabic variants", () => {
  assert.equal(normalize("Hôpital  d'Inezgane"), "hopital d inezgane");
  assert.equal(normalize("إنزكان"), "انزكان");
});

test("finds places by prefix, without accents, in Arabic, and loosely spelled", () => {
  const idx = new SearchIndex(net);
  assert.equal(idx.search("hopital")[0].label.d, "Hôpital Hassan II");
  assert.equal(idx.search("talb")[0].label.d, "Talborjt");
  assert.equal(idx.search("انزكان")[0].label.d, "Inezgane");
  assert.ok(idx.search("inezgan").some((h) => h.label.d === "Place d'Inezgane"));
});

test("a stop served in both directions shows once", () => {
  const hits = new SearchIndex(net).search("hassan");
  assert.equal(hits.filter((h) => h.kind === "stop").length, 1);
});

test("a number finds the line", () => {
  const [h] = new SearchIndex(net).search("32");
  assert.equal(h.kind, "line");
});
