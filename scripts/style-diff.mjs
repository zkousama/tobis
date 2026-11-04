// Compares two style records from `smoke.mjs --styles=`: every element on every
// screen, its box and computed style. Exits 1 and lists what moved.
//   node scripts/style-diff.mjs before.json after.json
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")));
let diffs = 0;
const MAX = 60;
for (const screen of new Set([...Object.keys(a), ...Object.keys(b)])) {
  const x = a[screen] ?? {};
  const y = b[screen] ?? {};
  for (const el of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!x[el] || !y[el]) {
      if (diffs++ < MAX) console.log(`${screen}: ${x[el] ? "gone" : "new"}  ${el}`);
      continue;
    }
    for (const p of new Set([...Object.keys(x[el]), ...Object.keys(y[el])]))
      if (x[el][p] !== y[el][p] && diffs++ < MAX) console.log(`${screen}: ${el}\n    ${p}: ${x[el][p]}  ->  ${y[el][p]}`);
  }
}
console.log(diffs ? `\n${diffs} difference(s)${diffs > MAX ? ` (first ${MAX} shown)` : ""}` : "styles identical");
process.exit(diffs ? 1 : 0);
