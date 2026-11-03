// Downloads a raw OpenStreetMap snapshot for one city into data/raw/<city>/.
// Usage: node scripts/fetch-osm.mjs agadir
import { readFile, writeFile, mkdir } from "node:fs/promises";

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const city = process.argv[2] ?? "agadir";
const cfg = JSON.parse(await readFile(`cities/${city}.json`, "utf8"));
const [w, s, e, n] = cfg.bbox;
const bb = `${s},${w},${n},${e}`;

const queries = {
  routes: `[out:json][timeout:180];
    relation["type"="route"]["route"~"^(bus|trolleybus)$"](${bb})->.r;
    .r out body;
    way(r.r); out geom;
    node(r.r); out body;`,
  stops: `[out:json][timeout:180];
    (
      node["highway"="bus_stop"](${bb});
      node["public_transport"~"^(platform|stop_position)$"]["bus"="yes"](${bb});
      node["public_transport"="platform"](${bb});
    );
    out body;`,
  places: `[out:json][timeout:240];
    (
      nwr["place"~"^(city|town|village|suburb|neighbourhood|quarter|hamlet|isolated_dwelling)$"]["name"](${bb});
      nwr["amenity"]["name"](${bb});
      nwr["healthcare"]["name"](${bb});
      nwr["shop"]["name"](${bb});
      nwr["office"]["name"](${bb});
      nwr["tourism"]["name"](${bb});
      nwr["leisure"]["name"](${bb});
      nwr["craft"]["name"](${bb});
      nwr["aeroway"="aerodrome"]["name"](${bb});
      nwr["historic"]["name"](${bb});
      nwr["building"~"^(hospital|school|university|mosque|government|public|commercial|hotel)$"]["name"](${bb});
      nwr["landuse"~"^(retail|commercial|industrial)$"]["name"](${bb});
    );
    out center tags;`,
};

async function overpass(q) {
  let wait = 5000;
  for (let attempt = 0; attempt < 20; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "agadir-bus-data/0.1" },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(200_000),
      });
      const text = await res.text();
      if (res.ok && text.startsWith("{")) {
        const json = JSON.parse(text);
        if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
        // Some mirrors lag months behind; only accept fresh data.
        const age = Date.now() - Date.parse(json.osm3s?.timestamp_osm_base ?? 0);
        if (!(age < 2 * 86400_000)) throw new Error(`stale data from ${json.osm3s?.timestamp_osm_base}`);
        return json;
      }
      console.warn(`  ${url}: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`  ${url}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 60_000);
  }
  throw new Error("all Overpass mirrors failed");
}

// The street network is too big for one query on a busy server, so it comes in tiles.
const ROADS = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|path|steps|track|cycleway|road|busway)(_link)?$";
async function fetchRoads(splits = 4) {
  const seen = new Map();
  let stamp;
  for (let i = 0; i < splits; i++)
    for (let j = 0; j < splits; j++) {
      const tw = w + ((e - w) * i) / splits, te = w + ((e - w) * (i + 1)) / splits;
      const ts = s + ((n - s) * j) / splits, tn = s + ((n - s) * (j + 1)) / splits;
      const file = `data/raw/${city}/roads-tiles/${i}-${j}.json`;
      const json = await readFile(file, "utf8").then(JSON.parse, async () => {
        const fresh = await overpass(`[out:json][timeout:180];way["highway"~"${ROADS}"](${ts},${tw},${tn},${te});out body geom;`);
        await mkdir(`data/raw/${city}/roads-tiles`, { recursive: true });
        await writeFile(file, JSON.stringify(fresh));
        return fresh;
      });
      stamp = json.osm3s?.timestamp_osm_base;
      for (const el of json.elements) seen.set(el.id, el);
      console.log(`  tile ${i * splits + j + 1}/${splits * splits}: ${json.elements.length} ways`);
    }
  return { osm3s: { timestamp_osm_base: stamp }, elements: [...seen.values()] };
}
queries.roads = fetchRoads;

await mkdir(`data/raw/${city}`, { recursive: true });
const only = process.argv.slice(3);
for (const [name, q] of Object.entries(queries)) {
  if (only.length && !only.includes(name)) continue;
  console.log(`fetching ${name}…`);
  const json = typeof q === "function" ? await q() : await overpass(q);
  await writeFile(`data/raw/${city}/${name}.json`, JSON.stringify(json));
  console.log(`  ${json.elements.length} elements, snapshot ${json.osm3s?.timestamp_osm_base}`);
}
