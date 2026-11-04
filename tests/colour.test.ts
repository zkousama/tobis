import { test } from "node:test";
import assert from "node:assert/strict";
import { luminance, textOn, visible } from "../src/ui/colour.ts";

const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test("pale line colours are darkened until they show on white", () => {
  for (const pale of ["#FFF8E1", "#F0F4C3", "#E1BEE7", "#FFE082"]) assert.ok(ratio(visible(pale), "#ffffff") >= 3, pale);
});
test("strong colours are left alone", () => {
  assert.equal(visible("#3933ff").toLowerCase(), "#3933ff");
});
test("badge text picks the readable side", () => {
  assert.equal(textOn("#ffe082"), "#111418");
  assert.equal(textOn("#3933ff"), "#ffffff");
});
