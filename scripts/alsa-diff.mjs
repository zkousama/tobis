// Compares two ALSA downloads (folders written by fetch-alsa.mjs) and prints what
// changed for a rider: lines added or gone, renamed, stops added, removed or
// reordered, fares and timetables. Exit 0 when nothing changed, 2 when something did.
//   node scripts/alsa-diff.mjs data/raw/agadir/alsa /tmp/alsa-now
import { readFileSync } from "node:fs";

const [oldDir, newDir] = process.argv.slice(2);
const load = (dir) => ({
  lines: JSON.parse(readFileSync(`${dir}/lines.json`, "utf8")).lines,
  details: JSON.parse(readFileSync(`${dir}/details.json`, "utf8")),
});
const a = load(oldDir);
const b = load(newDir);
const byId = (ls) => new Map(ls.map((l) => [l.id, l]));
const A = byId(a.lines);
const B = byId(b.lines);
const out = [];

const added = [...B.keys()].filter((k) => !A.has(k));
const gone = [...A.keys()].filter((k) => !B.has(k));
if (added.length) out.push(`- New lines: ${added.map((k) => `**${k}** (${B.get(k).surname ?? B.get(k).name})`).join(", ")}`);
if (gone.length) out.push(`- Lines no longer listed: ${gone.map((k) => `**${k}** (${A.get(k).surname ?? A.get(k).name})`).join(", ")}`);

const stopNames = (dir) => (dir?.stops ?? []).map((s) => s.name.trim());
const timetable = (d) => (JSON.stringify(d?.horario ?? null).match(/"(inicio|fin|frecuencia)":"[^"]+"/g) ?? []).join(" ");
const fare = (d) => JSON.stringify(d?.tarifa ?? null);

for (const [id, x] of A) {
  const y = B.get(id);
  if (!y) continue;
  const notes = [];
  if ((x.surname ?? x.name) !== (y.surname ?? y.name)) notes.push(`renamed "${x.surname ?? x.name}" → "${y.surname ?? y.name}"`);
  for (const dir of ["outgoing", "return"]) {
    const p = stopNames(x[dir]);
    const q = stopNames(y[dir]);
    if (p.join("|") === q.join("|")) continue;
    const plus = q.filter((s) => !p.includes(s));
    const minus = p.filter((s) => !q.includes(s));
    const parts = [];
    if (plus.length) parts.push(`stops added: ${plus.join(", ")}`);
    if (minus.length) parts.push(`stops removed: ${minus.join(", ")}`);
    if (!plus.length && !minus.length) parts.push("same stops, new order");
    notes.push(`${dir === "outgoing" ? "outbound" : "return"} (${p.length} → ${q.length} stops): ${parts.join("; ")}`);
  }
  if (fare(a.details[id]) !== fare(b.details[id])) notes.push("fare changed");
  if (timetable(a.details[id]) !== timetable(b.details[id])) notes.push(timetable(b.details[id]) ? "timetable changed (ALSA now publishes times)" : "timetable changed");
  if (notes.length) out.push(`- **${id}**: ${notes.join("; ")}`);
}

if (!out.length) {
  console.log("No change in ALSA's lines, stops, fares or timetables.");
  process.exit(0);
}
console.log(out.join("\n"));
process.exit(2);
