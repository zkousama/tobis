// Writes a JOSM file that fills in the two existing (nearly empty) Trambus
// route relations: platforms in travel order, then the ways the line runs on.
// Nothing is uploaded: open the file in JOSM, check it, and upload yourself.
// Usage: node scripts/osm-draft-trambus.mjs agadir
import { readFile, writeFile, mkdir } from "node:fs/promises";

const city = process.argv[2] ?? "agadir";
const report = JSON.parse(await readFile(`data/reports/${city}.json`, "utf8"));
const cfg = JSON.parse(await readFile(`cities/${city}.json`, "utf8"));
const drafts = report.brtDraft;
if (!drafts?.length) throw new Error("run scripts/build-data.mjs first");

// The existing relations, one per direction (from the OSM data).
// 18497003 (v15) is the one a mapper has been building, Port → Tikiouine: keep that direction.
const RELATIONS = { "Port": 18497003, "El Hajeb": 18493234 };
const API = "https://api.openstreetmap.org/api/0.6";
const UA = { "user-agent": "agadir-bus-osm-draft/0.1" };

const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="agadir-bus osm-draft" upload="true">'];

for (const d of drafts) {
  const id = RELATIONS[d.from];
  const xml = await (await fetch(`${API}/relation/${id}`, { headers: UA })).text();
  const version = /<relation[^>]*version="(\d+)"/.exec(xml)?.[1];
  const tags = Object.fromEntries([...xml.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]));
  Object.assign(tags, {
    type: "route",
    route: "bus",
    "public_transport:version": "2",
    name: `BHNS L1: ${d.from} → ${d.to}`,
    ref: "L1",
    from: d.from,
    to: d.to,
    network: "Amalway",
    operator: tags.operator ?? "Amalway Agadir",
    interval: String(cfg.brt.headwayMin ?? ""),
    website: "https://beta.amalway.ma/",
  });
  if (!tags.interval) delete tags.interval;
  out.push(`  <relation id="${id}" action="modify" version="${version}" visible="true">`);
  for (const n of d.platforms) out.push(`    <member type="node" ref="${n}" role="platform"/>`);
  for (const w of d.ways) out.push(`    <member type="way" ref="${w}" role=""/>`);
  for (const [k, v] of Object.entries(tags).sort()) out.push(`    <tag k="${esc(k)}" v="${esc(v)}"/>`);
  out.push("  </relation>");
  console.log(`relation ${id} v${version}: ${d.from} → ${d.to}, ${d.platforms.length} platforms, ${d.ways.length} ways`);
}
out.push("</osm>");
await mkdir("data/osm-drafts", { recursive: true });
await writeFile("data/osm-drafts/trambus.osm", out.join("\n") + "\n");
console.log("wrote data/osm-drafts/trambus.osm");
