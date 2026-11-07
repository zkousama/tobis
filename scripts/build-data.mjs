// Turns the raw OSM snapshot in data/raw/<city>/ into public/data/<city>.json,
// the compact network the app routes on.
// Usage: node scripts/build-data.mjs agadir
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { RoadGraph } from "./roadgraph.mjs";

const city = process.argv[2] ?? "agadir";
const cfg = JSON.parse(await readFile(`cities/${city}.json`, "utf8"));
const load = async (n) => JSON.parse(await readFile(`data/raw/${city}/${n}.json`, "utf8"));
const routesRaw = await load("routes");
const stopsRaw = await load("stops");
const placesRaw = await load("places");
const graph = await access(`data/raw/${city}/roads.json`).then(
  async () => new RoadGraph(await load("roads")),
  () => null,
);
if (!graph) console.warn("no roads.json: line shapes come from relation way order only");

// Douglas-Peucker in metres; keeps both ends so stops stay exact.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const kx = Math.cos(rad(pts[0][1])) * 111_320, ky = 110_540;
  const xy = pts.map(([x, y]) => [x * kx, y * ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = tol;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Follow the streets from stop to stop, preferring the ways the relation lists.
function traceStops(rel, stopLLs, mode = "drive") {
  const relWays = new Set(rel.members.filter((m) => m.type === "way").map((m) => m.ref));
  const weight = (e) => (relWays.has(e.way) ? 1 : 2.5);
  const coords = [stopLLs[0]];
  const along = [0];
  const legStats = [];
  const wayIds = []; // OSM ways the traced path runs on, in order (for OSM drafts)
  let straight = 0;
  for (let i = 0; i < stopLLs.length - 1; i++) {
    const a = stopLLs[i], b = stopLLs[i + 1];
    const crow = dist(a, b);
    const seeds = (p) => graph.near(p, 90, mode).slice(0, 8).map((x) => ({ i: x.i, cost: x.d * 2 }));
    const res = graph.path(seeds(a), seeds(b), mode, weight, crow * 5 + 2000);
    let leg;
    let onRel = 0;
    if (res && res.metres < crow * 4 + 1500) {
      leg = [...res.nodes.map((n) => graph.coord[n]), b];
      // How much of this stretch runs on ways the relation itself lists.
      for (let k = 1; k < res.nodes.length; k++) {
        const e = graph.adj[res.nodes[k - 1]].find((x) => x.to === res.nodes[k]);
        if (e && relWays.has(e.way)) onRel += e.len;
        if (e && wayIds.at(-1) !== e.way) wayIds.push(e.way);
      }
      onRel /= Math.max(1, res.metres);
    } else {
      leg = [b];
      straight++;
    }
    legStats.push({ crow, metres: res?.metres ?? crow, onRel, path: res ? res.nodes.map((n) => graph.coord[n]) : [a, b] });
    leg = simplify([coords.at(-1), ...leg], 3).slice(1);
    let m = 0;
    let last = coords.at(-1);
    for (const c of leg) {
      m += dist(last, c);
      coords.push(c);
      last = c;
    }
    along.push(along.at(-1) + m);
  }
  return { coords, along, straight, legStats, wayIds };
}

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function dist(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const round5 = (v) => Math.round(v * 1e5) / 1e5;

const nodes = new Map();
const ways = new Map();
const rels = [];
for (const el of routesRaw.elements) {
  if (el.type === "node") nodes.set(el.id, el);
  else if (el.type === "way") ways.set(el.id, el);
  else if (el.type === "relation") rels.push(el);
}
for (const el of stopsRaw.elements) if (!nodes.has(el.id)) nodes.set(el.id, el);

const isNetwork = (t) =>
  cfg.networks.some((n) => [t.network, t.operator].some((v) => v && v.toLowerCase().includes(n.toLowerCase().split(" ")[0])));

// ---- shapes: chain a relation's ways into one polyline ----
function wayCoords(w) {
  return w.geometry.map((g) => [g.lon, g.lat]);
}
function assembleShape(rel) {
  const members = rel.members.filter((m) => m.type === "way" && (m.role === "" || m.role === "forward" || m.role === "backward") && ways.has(m.ref));
  const out = []; // [lon,lat]
  const outNodes = [];
  let gaps = 0;
  for (let i = 0; i < members.length; i++) {
    const w = ways.get(members[i].ref);
    let ids = w.nodes.slice();
    let pts = wayCoords(w);
    const closed = ids[0] === ids.at(-1) && ids.length > 2;
    const next = members[i + 1] && ways.get(members[i + 1].ref);
    const nextIds = next ? new Set([next.nodes[0], next.nodes.at(-1), ...(next.nodes[0] === next.nodes.at(-1) ? next.nodes : [])]) : null;
    const tail = outNodes.at(-1);
    if (closed) {
      // Roundabout: enter at the node we arrived on, follow way direction to the exit.
      const loopIds = ids.slice(0, -1);
      const loopPts = pts.slice(0, -1);
      let start = tail !== undefined ? loopIds.indexOf(tail) : 0;
      if (start < 0) start = 0;
      const seqIds = [];
      const seqPts = [];
      for (let k = 0; k <= loopIds.length; k++) {
        const idx = (start + k) % loopIds.length;
        seqIds.push(loopIds[idx]);
        seqPts.push(loopPts[idx]);
        if (k > 0 && nextIds && nextIds.has(loopIds[idx])) break;
      }
      ids = seqIds;
      pts = seqPts;
    } else if (tail !== undefined) {
      if (ids.at(-1) === tail) {
        ids.reverse();
        pts.reverse();
      } else if (ids[0] !== tail) {
        // Not connected to what came before: orient by geometry and count the gap.
        gaps++;
        const end = out.at(-1);
        if (dist(end, pts.at(-1)) < dist(end, pts[0])) {
          ids.reverse();
          pts.reverse();
        }
      }
    } else if (next) {
      // First way: orient it so its end touches the next way.
      if (nextIds.has(ids[0]) && !nextIds.has(ids.at(-1))) {
        ids.reverse();
        pts.reverse();
      }
    }
    const skipFirst = tail !== undefined && ids[0] === tail;
    for (let k = skipFirst ? 1 : 0; k < ids.length; k++) {
      outNodes.push(ids[k]);
      out.push(pts[k]);
    }
  }
  return { coords: out, gaps };
}

// Cumulative distance along a polyline.
function cumulative(coords) {
  const c = [0];
  for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + dist(coords[i - 1], coords[i]));
  return c;
}
// Project p onto the polyline from segment `from` onwards; returns {along, offset, seg}.
function project(coords, cum, p, from = 0) {
  let best = { along: 0, offset: Infinity, seg: from };
  const kx = Math.cos(rad(p[1]));
  for (let i = Math.max(0, from); i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const ax = (a[0] - p[0]) * kx, ay = a[1] - p[1];
    const bx = (b[0] - p[0]) * kx, by = b[1] - p[1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const off = dist(q, p);
    if (off < best.offset) best = { along: cum[i] + (cum[i + 1] - cum[i]) * t, offset: off, seg: i };
  }
  return best;
}

// ---- stops ----
const NUMERIC = /^[\d\s,;/-]*$/;
const stopIndex = new Map(); // osm node id -> index
const stops = [];
// Moroccan OSM names often carry all three scripts: "Tikiouine ⵜⵉⴽⵉⵡⵉⵏ تيكوين".
// Split them so each language shows its own script.
const SCRIPT = { arab: /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/, tfng: /[\u2d30-\u2d7f]/ };
function splitScripts(v) {
  const parts = { latn: [], arab: [], tfng: [] };
  let cur = null, buf = "";
  const flush = () => { if (buf.trim() && cur) parts[cur].push(buf.trim()); buf = ""; };
  for (const word of v.split(/\s+/)) {
    const sc = SCRIPT.arab.test(word) ? "arab" : SCRIPT.tfng.test(word) ? "tfng" : "latn";
    if (sc !== cur) {
      flush();
      cur = sc;
    }
    buf += " " + word;
  }
  flush();
  return { latn: parts.latn.join(" "), arab: parts.arab.join(" "), tfng: parts.tfng.join(" ") };
}
// "ANNA HOTEL AGADIR" reads better as "Anna Hotel Agadir".
const unshout = (v) => (v === v.toUpperCase() && /[A-Z]{4}/.test(v) && !/\.[A-Z]/.test(v) ? v.toLowerCase().replace(/(^|[\s(/'-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : v);
function names(t = {}) {
  const n = {};
  for (const k of ["name", "name:fr", "name:ar", "name:en", "name:zgh"]) if (t[k] && !NUMERIC.test(t[k])) n[k === "name" ? "d" : k.slice(5)] = t[k].trim();
  if (n.d) n.d = unshout(n.d);
  if (n.d) {
    const sp = splitScripts(n.d);
    const scripts = [sp.latn, sp.arab, sp.tfng].filter(Boolean).length;
    if (scripts > 1) {
      if (sp.latn) n.d = sp.latn.replace(/[\s/|-]+$/, "");
      else if (sp.arab) n.d = sp.arab;
      if (sp.arab && !n.ar) n.ar = sp.arab;
      if (sp.tfng && !n.zgh) n.zgh = sp.tfng;
    } else if (sp.arab && !sp.latn && !n.ar) n.ar = n.d;
  }
  return n;
}
function addStop(id) {
  if (stopIndex.has(id)) return stopIndex.get(id);
  const n = nodes.get(id);
  if (!n || n.lat === undefined) return -1;
  const i = stops.length;
  stops.push({ id, ll: [round5(n.lon), round5(n.lat)], n: names(n.tags) });
  stopIndex.set(id, i);
  return i;
}

// ---- places (search + "near" labels) ----
const KIND = (t) =>
  t.place ? (["city", "town", "village", "hamlet", "isolated_dwelling"].includes(t.place) ? "town" : "area")
  : t.aeroway ? "airport"
  : t.amenity === "bus_station" ? "station"
  : ["university", "college", "school", "kindergarten", "language_school", "driving_school"].includes(t.amenity) || ["school", "university"].includes(t.building) ? "school"
  : ["hospital", "clinic", "doctors", "dentist", "pharmacy"].includes(t.amenity) || t.healthcare || t.building === "hospital" ? "health"
  : t.amenity === "place_of_worship" || t.building === "mosque" ? "worship"
  : ["townhall", "police", "post_office", "courthouse", "public_building", "fire_station"].includes(t.amenity) || t.office === "government" || t.building === "government" ? "gov"
  : ["cafe", "restaurant", "fast_food", "ice_cream", "bar"].includes(t.amenity) ? "food"
  : ["bank", "atm", "bureau_de_change"].includes(t.amenity) ? "bank"
  : t.shop || t.landuse === "retail" || t.landuse === "commercial" ? "shop"
  : t.tourism === "hotel" || t.tourism === "hostel" || t.tourism === "guest_house" || t.building === "hotel" ? "hotel"
  : t.leisure || t.tourism ? "leisure"
  : "poi";
// The specific kind of place, for the line under a search result ("Médecin", "Pharmacie").
const TYPE = (t) => t.healthcare ?? t.amenity ?? (t.shop ? `shop:${t.shop}` : undefined) ?? t.tourism ?? t.leisure ?? t.office ?? t.place ?? t.building ?? t.historic;
const normKeyEarly = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const places = [];
const seenPlace = new Set();
for (const el of placesRaw.elements) {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat === undefined) continue;
  const n = names(t);
  if (!n.d) continue;
  const key = `${n.d.toLowerCase()}|${Math.round(lat * 200)}|${Math.round(lon * 200)}`;
  if (seenPlace.has(key)) continue;
  seenPlace.add(key);
  const type = TYPE(t);
  places.push({ ll: [round5(lon), round5(lat)], n, k: KIND(t), ...(type && type !== "yes" ? { t: type } : {}) });
}

// Overture places (Meta, Microsoft and others, CDLA-Permissive-2.0): far more
// shops, clinics and offices than OSM has here. Only name, kind and position
// are kept; phone numbers and emails in the source are dropped.
const OV_KIND = (c) =>
  /dental|doctor|clinic|hospital|pharmacy|health|medical|medicine|diagnostic|physical|perinatal|vision|eye_care|outpatient|mental/.test(c) ? "health"
  : /school|learning|education|college|university|tutoring|preschool|library/.test(c) ? "school"
  : /restaurant|cafe|coffee|eatery|fast_food|bar$|juice|food_service|lounge|bakery/.test(c) ? "food"
  : /hotel|lodging|resort|bed_and_breakfast|campground/.test(c) ? "hotel"
  : /financial|bank|credit_union/.test(c) ? "bank"
  : /government|community_and_government|civic/.test(c) ? "gov"
  : /worship|mosque/.test(c) ? "worship"
  : /store|shopping|mall|market/.test(c) ? "shop"
  : /sport|gym|fitness|park|beach|stadium|museum|historic|pool|arts|gallery|cultural|venue|club|recreation/.test(c) ? "leisure"
  : /airport/.test(c) ? "airport"
  : "poi";
{
  const file = `data/raw/${city}/overture/places.geojsonseq`;
  const text = await readFile(file, "utf8").catch(() => "");
  const osmKeys = places.map((p) => ({ k: normKeyEarly(p.n.d), ll: p.ll }));
  let added = 0, skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    const pr = f.properties ?? {};
    const cat = pr.basic_category ?? pr.taxonomy?.primary ?? "";
    const kind = OV_KIND(cat);
    if ((pr.confidence ?? 0) < (kind === "health" ? 0.35 : 0.5)) continue;
    const name = pr.names?.primary;
    if (!name || f.geometry?.type !== "Point") continue;
    const ll = [round5(f.geometry.coordinates[0]), round5(f.geometry.coordinates[1])];
    const k = normKeyEarly(name);
    if (osmKeys.some((o) => o.k === k && dist(o.ll, ll) < 200)) {
      skipped++;
      continue;
    }
    const n = names({ name });
    if (!n.d) continue;
    places.push({ ll, n, k: kind, ...(cat ? { t: cat } : {}), src: "ov" });
    added++;
  }
  if (text) console.log(`${added} Overture places (${skipped} already in OSM)`);
}

// Commune outlines, for taxi rules (a petit taxi stays in its commune).
const communes = [];
{
  const raw = await load("communes").catch(() => ({ elements: [] }));
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  for (const rel of raw.elements) {
    const parts = rel.members.filter((m) => m.type === "way" && m.role !== "inner" && m.geometry?.length).map((m) => m.geometry.map((g) => [g.lon, g.lat]));
    const rings = [];
    while (parts.length) {
      let ring = parts.shift();
      for (let grew = true; grew && key(ring[0]) !== key(ring.at(-1)); ) {
        grew = false;
        for (let i = 0; i < parts.length; i++) {
          const w = parts[i];
          if (key(w[0]) === key(ring.at(-1))) ring = ring.concat(w.slice(1));
          else if (key(w.at(-1)) === key(ring.at(-1))) ring = ring.concat([...w].reverse().slice(1));
          else continue;
          parts.splice(i, 1);
          grew = true;
          break;
        }
      }
      if (ring.length >= 4) rings.push(simplify(ring, 40).map(([x, y]) => [round5(x), round5(y)]));
    }
    const n = names(rel.tags ?? {});
    if (rings.length && n.d) communes.push({ n, rings });
  }
  console.log(`${communes.length} commune outlines`);
}

// Street names, so "Avenue Hassan II" can be searched. One point per street per
// area: the street's middle node, with same-named streets far apart kept apart.
if (graph) {
  const STREETS = /^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|trunk)(_link)?$/;
  const byName = new Map();
  for (const w of (await load("roads")).elements) {
    const t = w.tags ?? {};
    if (!t.name || !STREETS.test(t.highway ?? "") || !w.geometry?.length) continue;
    const mid = w.geometry[Math.floor(w.geometry.length / 2)];
    const ll = [mid.lon, mid.lat];
    const list = byName.get(t.name) ?? [];
    const near = list.find((c) => dist(c.ll, ll) < 1500);
    if (near) near.n++;
    else list.push({ ll, n: 1, tags: t });
    byName.set(t.name, list);
  }
  let added = 0;
  for (const list of byName.values())
    for (const c of list) {
      const n = names(c.tags);
      if (!n.d) continue;
      places.push({ ll: [round5(c.ll[0]), round5(c.ll[1])], n, k: "street", t: c.tags.highway });
      added++;
    }
  console.log(`${added} street names`);
}

// ---- lines ----
const PALETTE = ["#d7263d", "#1b998b", "#2e86de", "#f46036", "#7b2cbf", "#2a9d8f", "#e9a400", "#c2185b", "#3949ab", "#00897b", "#6d4c41", "#5e8c31", "#ad1457", "#0277bd", "#ef6c00", "#455a64"];
const report = { gaps: [], noStops: [], farStops: [], untrusted: [], reordered: [], sides: [] };
// Sections whose street path drives past 2+ other stops of the same direction:
// the stop order is wrong there, so the router won't ride through them.
function findBreaks(seqIdx, legStats) {
  const breaks = [];
  const passes = [];
  legStats.forEach((l, k) => {
    const passed = new Set();
    for (const c of l.path)
      seqIdx.forEach((si, j) => {
        if (j >= k - 1 && j <= k + 2) return;
        if (dist(c, stops[si].ll) < 45) passed.add(si);
      });
    if (passed.size >= 2) {
      breaks.push(k);
      passes.push([...passed]);
    }
  });
  return { breaks, passes };
}

function trace(rel, seqIdx, mode) {
  if (!graph || seqIdx.length < 2) return null;
  const tr = traceStops(rel, seqIdx.map((i) => stops[i].ll), mode);
  const { breaks, passes } = findBreaks(seqIdx, tr.legStats);
  return { ...tr, seqIdx, breaks, passes, share: breaks.length / Math.max(1, seqIdx.length - 1) };
}

// Order stops along a reference path (the clean opposite direction, reversed).
function orderAlong(seqIdx, refCoords) {
  const cum = cumulative(refCoords);
  const placed = [];
  const off = [];
  for (const si of seqIdx) {
    const pr = project(refCoords, cum, stops[si].ll, 0);
    (pr.offset < 150 ? placed : off).push({ si, a: pr.along });
  }
  placed.sort((x, y) => x.a - y.a);
  const order = placed.map((x) => x.si);
  for (const { si } of off) insertCheapest(order, si);
  return order;
}
function insertCheapest(order, si) {
  let best = order.length, bestCost = Infinity;
  for (let k = 0; k <= order.length; k++) {
    const a = order[k - 1], b = order[k];
    const cost = (a !== undefined ? dist(stops[a].ll, stops[si].ll) : 0) + (b !== undefined ? dist(stops[si].ll, stops[b].ll) : 0) - (a !== undefined && b !== undefined ? dist(stops[a].ll, stops[b].ll) : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = k;
    }
  }
  order.splice(best, 0, si);
}
// Shortest open chain through all stops from one terminal to the other (2-opt).
function orderChain(seqIdx, first, last) {
  const rest = seqIdx.filter((s) => s !== first && s !== last);
  const order = [first];
  const left = new Set(rest);
  while (left.size) {
    const cur = order.at(-1);
    let nb = null, nd = Infinity;
    for (const s of left) {
      const d = dist(stops[cur].ll, stops[s].ll);
      if (d < nd) {
        nd = d;
        nb = s;
      }
    }
    order.push(nb);
    left.delete(nb);
  }
  order.push(last);
  const D = (a, b) => dist(stops[a].ll, stops[b].ll);
  for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
    improved = false;
    for (let i = 1; i < order.length - 2; i++)
      for (let j = i + 1; j < order.length - 1; j++) {
        const delta = D(order[i - 1], order[j]) + D(order[i], order[j + 1]) - D(order[i - 1], order[i]) - D(order[j], order[j + 1]);
        if (delta < -1) {
          order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse());
          improved = true;
        }
      }
  }
  return order;
}
// Terminals of a direction: the stop nearest each end of the opposite direction,
// or else the two stops farthest apart, oriented by the relation's from/to names.
function terminals(seqIdx, opposite, tags) {
  const nearest = (p) => seqIdx.reduce((b, s) => (dist(stops[s].ll, p) < dist(stops[b].ll, p) ? s : b), seqIdx[0]);
  if (opposite) return [nearest(opposite.coords.at(-1)), nearest(opposite.coords[0])];
  let A = seqIdx[0], B = seqIdx[1], far = 0;
  for (const a of seqIdx) for (const b of seqIdx) { const d = dist(stops[a].ll, stops[b].ll); if (d > far) { far = d; A = a; B = b; } }
  const sim = (s, name) => { const n = (stops[s].n.d ?? "").toLowerCase(); return name && n && name.toLowerCase().split(/[^a-zà-ÿ]+/).filter((w) => w.length > 3 && n.includes(w)).length; };
  return sim(B, tags.from) > sim(A, tags.from) || sim(A, tags.to) > sim(B, tags.to) ? [B, A] : [A, B];
}

// Share of stops on the right-hand side of the street, in travel order.
// Morocco drives on the right, so a correctly oriented direction scores high.
function rightSide(tr) {
  let right = 0, n = 0;
  tr.legStats.forEach((l, k) => {
    const p = l.path;
    if (p.length < 2) return;
    const s = stops[tr.seqIdx[k]].ll;
    const kx = Math.cos(rad(s[1]));
    // Direction of the street where the bus leaves this stop.
    let j = 1;
    while (j < p.length - 1 && dist(p[0], p[j]) < 15) j++;
    const dx = (p[j][0] - p[0][0]) * kx, dy = p[j][1] - p[0][1];
    const ox = (s[0] - p[0][0]) * kx, oy = s[1] - p[0][1];
    if (dist(s, p[0]) < 3 || Math.hypot(dx, dy) === 0) return;
    const cross = dx * oy - dy * ox;
    n++;
    if (cross < 0) right++;
  });
  return { right, n, share: n ? right / n : 0.5 };
}

const SCRAMBLED = 0.15;
const entries = [];
const ALSA_DIR = `data/raw/${city}/alsa`;
const alsa = cfg.sources?.includes("alsa") ? JSON.parse(await readFile(`${ALSA_DIR}/lines.json`, "utf8")) : null;
const alsaDetails = alsa ? JSON.parse(await readFile(`${ALSA_DIR}/details.json`, "utf8").catch(() => "{}")) : {};
for (const rel of alsa ? [] : rels) {
  const t = rel.tags ?? {};
  if (!isNetwork(t)) continue;
  const isBrt = /amalway|bhns/i.test(`${t.network} ${t.operator} ${t.name} ${t.ref}`);
  const ref = isBrt ? "BHNS" : (t.ref ?? "?").trim();
  const stopMembers = rel.members.filter((m) => m.type === "node" && /^(platform|stop|bus_stop)(_entry_only|_exit_only)?$/.test(m.role));
  // Prefer platforms; fall back to stop positions where a line only has those.
  const platforms = stopMembers.filter((m) => m.role.startsWith("platform"));
  const use = platforms.length >= 2 ? platforms : stopMembers;
  const seqIdx = [];
  for (const m of use) {
    const si = addStop(m.ref);
    if (si >= 0 && !seqIdx.includes(si)) seqIdx.push(si);
  }
  entries.push({ rel, t, ref, isBrt, seqIdx, tr: trace(rel, seqIdx) });
  const last = entries.at(-1);
  if (last.tr) report.sides.push({ rel: rel.id, ref, clean: last.tr.share <= SCRAMBLED, ...rightSide(last.tr) });
}

// ---- ALSA: the operator's own lines, with stops in order ----
function cleanName(raw) {
  let n = String(raw ?? "").replace(/\s+V$/, "").replace(/\s+/g, " ").trim();
  // ALL-CAPS names read better in title case; keep abbreviations like "H.R.ATLAS".
  if (n === n.toUpperCase() && /[A-Z]{4}/.test(n) && !/\.[A-Z]/.test(n)) n = n.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  return n;
}
const alsaStopIndex = new Map();
function addAlsaStop(s) {
  if (alsaStopIndex.has(s.id)) return alsaStopIndex.get(s.id);
  if (!s.lat || !s.lon) return -1;
  const i = stops.length;
  stops.push({ id: s.id, src: "alsa", ll: [round5(s.lon), round5(s.lat)], n: { d: cleanName(s.name) } });
  alsaStopIndex.set(s.id, i);
  return i;
}
// OSM ways the same line number uses, to steer street tracing onto the right roads.
function osmWaysFor(ref) {
  const members = [];
  for (const r of rels) if (isNetwork(r.tags ?? {}) && (r.tags.ref ?? "").trim() === ref) for (const m of r.members) if (m.type === "way") members.push(m);
  return members;
}
function parseFare(raw) {
  const t = raw?.tarifa;
  if (!Array.isArray(t)) return undefined;
  const flat = t.find((x) => "normal" in x);
  const num = (v) => (v && /^\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : undefined);
  if (flat) {
    const normal = num(flat.normal);
    return normal ? { kind: "flat", normal, card: num(flat.ikhlas), transfer: num(flat.transbordos) } : undefined;
  }
  const fr = t.find((x) => x.barrios_fr_FR)?.barrios_fr_FR?.split(",").map((x) => x.trim());
  const ar = t.find((x) => x.barrios_ar_SA)?.barrios_ar_SA?.split(",").map((x) => x.trim());
  const codes = (key) => Object.fromEntries((t.find((x) => x[key])?.[key] ?? "").split(",").filter(Boolean).map((c) => { const [a, b, p] = c.split("-"); return [`${Math.min(a, b)}-${Math.max(a, b)}`, Number(p)]; }));
  if (!fr?.length) return undefined;
  return { kind: "zones", zones: fr.map((f, i) => ({ fr: f, ar: ar?.[i] })), normal: codes("codigo"), card: codes("codigoIkhlas") };
}
// For zone fares: which zone each stop of a direction falls in (nearest zone town).
const normKey = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Loose comparison for place names spelled many ways (Imiouadar / Imi Ouadar, Tamaait / Tamait).
const skeleton = (v) => normKey(v).replace(/^(el|al|l|la|le)\s+/, "").replace(/\s+/g, "").replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1").replace(/q/g, "k");
function looseSim(a, b) {
  const tri = (v) => { const x = `  ${skeleton(v)} `; const o = new Set(); for (let i = 0; i < x.length - 2; i++) o.add(x.slice(i, i + 3)); return o; };
  const A = tri(a), B = tri(b);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / (A.size + B.size - n || 1);
}
// For zone fares: which zone each stop of a direction falls in (nearest zone town).
function zonesFor(seqIdx, fare, cityEnd) {
  const nearLine = (ll) => Math.min(...seqIdx.map((si) => dist(stops[si].ll, ll)));
  const anchors = fare.zones.map((z, zi) => {
    const key = normKey(z.fr);
    const exact = seqIdx.find((si) => normKey(stops[si].n.d).includes(key));
    if (exact !== undefined) return stops[exact].ll;
    // Closest spelling among this line's stops, then among places near the line.
    let best = null, bestS = 0.45;
    for (const si of seqIdx) { const sc = looseSim(z.fr, stops[si].n.d.replace(/\b(centre|terminus|entree|entrée|college|ecole)\b/gi, "")); if (sc > bestS) { bestS = sc; best = stops[si].ll; } }
    if (best) return best;
    for (const p of places) { if (p.k !== "town" && p.k !== "area") continue; const sc = looseSim(z.fr, p.n.d); if (sc > bestS && nearLine(p.ll) < 3000) { bestS = sc; best = p.ll; } }
    if (best) return best;
    // The first zone is the city end ("Place Salam", "Place Inezgane").
    return zi === 0 ? cityEnd : null;
  });
  if (anchors.some((a) => !a)) return undefined;
  return seqIdx.map((si) => anchors.reduce((best, a, i) => (dist(stops[si].ll, a) < dist(stops[si].ll, anchors[best]) ? i : best), 0));
}

// ALSA's published hours: [first, last, first, last, every N min] per day type. Most lines carry the
// same filler (6:25 to 10:30), so only hours that span a real day (8 hours or more) are kept.
function parseHours(raw) {
  const winter = raw?.horarios?.find((h) => h.invierno)?.invierno ?? (raw?.horarios?.[0] && Object.values(raw.horarios[0])[0]);
  const weekday = winter?.find?.((d) => d.lunesViernes)?.lunesViernes;
  const vals = (weekday ?? []).map((x) => Object.values(x)[0]);
  const mins = (t) => (/^\d{1,2}:\d{2}$/.test(t ?? "") ? Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]) : undefined);
  const times = vals.slice(0, 4).map(mins).filter((m) => m !== undefined);
  if (times.length < 2) return undefined;
  const first = Math.min(...times), last = Math.max(...times);
  if (last - first < 8 * 60) return undefined;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const every = Number(vals[4]);
  return { hours: { first: hhmm(first), last: hhmm(last) }, headway: every > 0 && every <= 120 ? every : undefined };
}

if (alsa) {
  for (const l of alsa.lines) {
    const ref = l.id.replace(/^L-?/, "");
    // Lines that no longer run but that ALSA's site still lists (see cities/<id>.json, with the source).
    if (cfg.removedLines?.[ref]) {
      console.log(`  line ${ref} left out: ${cfg.removedLines[ref]}`);
      continue;
    }
    const fare = parseFare(alsaDetails[l.id]?.tarifa);
    const published = parseHours(alsaDetails[l.id]?.horario);
    for (const dirKey of ["outgoing", "return"]) {
      const dir = l[dirKey];
      const seqIdx = [];
      for (const s of dir?.stops ?? []) {
        const si = addAlsaStop(s);
        if (si >= 0 && seqIdx.at(-1) !== si) seqIdx.push(si);
      }
      if (seqIdx.length < 2) {
        report.noStops.push({ rel: `${l.id}:${dirKey}`, ref, name: l.surname, stops: seqIdx.length });
        continue;
      }
      const rel = { id: `alsa:${l.id}:${dirKey}`, members: osmWaysFor(ref) };
      const tr = trace(rel, seqIdx);
      // ALSA gives the return the outbound's names (same header and end) for almost every line:
      // the return goes from the outbound's end back to its start.
      const copied = dirKey === "return" && dir.lineHeader === l.outgoing?.lineHeader && dir.lineEnd === l.outgoing?.lineEnd;
      const t = {
        from: cleanName(copied ? dir.lineEnd : dir.lineHeader),
        to: cleanName(copied ? dir.lineHeader : dir.lineEnd),
        name: cleanName(l.surname.replace(/^[^A-Z]*:\s*/, "")),
      };
      entries.push({ rel, t, ref, isBrt: false, seqIdx, tr, alsa: true, fare, colour: `#${String(l.color).replace("#", "")}`, ...(published?.hours ? { hours: published.hours } : {}), ...(published?.headway ? { headway: published.headway } : {}) });
      if (tr) report.sides.push({ rel: rel.id, ref, clean: tr.share <= SCRAMBLED, ...rightSide(tr) });
    }
  }
}

// ---- Trambus: stations mapped in OSM, put in the documented order ----
if (cfg.brt) {
  const loosen = (v) => normKey(v).replace(/\b(al|el|la|le|place|station|terminus)\b/g, " ").replace(/ou/g, "u").replace(/[aeiouy]/g, "").replace(/\s+/g, "");
  const tri = (v) => { const s = `  ${loosen(v)} `; const out = new Set(); for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3)); return out; };
  const sim = (a, b) => { const A = tri(a), B = tri(b); let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n || 1); };
  const brtNodes = stopsRaw.elements.filter((e) => /amalway|bhns|trambus/i.test(JSON.stringify(e.tags ?? {})) && e.tags?.name);
  const groups = new Map();
  for (const e of brtNodes) {
    const k = normKey(e.tags.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let stations = [];
  for (const name of cfg.brt.stations) {
    const osmName = cfg.brt.osmNames?.[name] ?? name;
    let best = groups.get(normKey(osmName)) ?? null;
    if (!best) {
      let bestS = 0.34;
      for (const [k, nodesOf] of groups) {
        const sc = sim(osmName, k);
        if (sc > bestS) {
          bestS = sc;
          best = nodesOf;
        }
      }
    }
    if (best) stations.push({ name, nodes: best });
    else report.brtUnmatched = [...(report.brtUnmatched ?? []), name];
  }
  // Order by where the stations actually are along the corridor; note any
  // place where that disagrees with the published list.
  {
    const ll = (st) => [st.nodes[0].lon, st.nodes[0].lat];
    const first = stations[0], last = stations.at(-1);
    const rest = stations.slice(1, -1);
    const order = [first];
    const left = new Set(rest);
    while (left.size) {
      const cur = order.at(-1);
      let nb = null, nd = Infinity;
      for (const st of left) { const d = dist(ll(cur), ll(st)); if (d < nd) { nd = d; nb = st; } }
      order.push(nb);
      left.delete(nb);
    }
    order.push(last);
    const swapped = order.map((st, i) => (st !== stations[i] ? st.name : null)).filter(Boolean);
    if (swapped.length) report.brtOrderDiffers = swapped;
    stations = order;
  }
  // Each station has a platform per direction: take the one on the right of travel.
  const pick = (k, forward) => {
    const st = stations[k];
    if (st.nodes.length === 1) return st.nodes[0];
    const prev = stations[Math.max(0, k - 1)].nodes[0], next = stations[Math.min(stations.length - 1, k + 1)].nodes[0];
    const [a, b] = forward ? [prev, next] : [next, prev];
    const dx = b.lon - a.lon, dy = b.lat - a.lat;
    const side = (n) => dx * (n.lat - a.lat) - dy * (n.lon - a.lon); // < 0: right of travel
    return [...st.nodes].sort((x, y) => side(x) - side(y))[0];
  };
  const busways = [...(graph?.ways ?? new Map()).entries()].filter(([, tg]) => tg.highway === "busway" || tg.busway || tg["bus:lanes"]).map(([id]) => ({ type: "way", ref: id }));
  for (const forward of [true, false]) {
    const order = stations.map((_, k) => k);
    if (!forward) order.reverse();
    const seqIdx = order.map((k) => {
      const n = pick(k, forward);
      nodes.set(n.id, { ...n, tags: { ...n.tags, name: stations[k].name } });
      return addStop(n.id);
    }).filter((i) => i >= 0);
    const rel = { id: `brt:${forward ? "a" : "b"}`, members: busways };
    // The Trambus has its own two-way lane down the middle of the avenues.
    const tr = trace(rel, seqIdx, "anyDrive");
    const ends = forward ? [stations[0].name, stations.at(-1).name] : [stations.at(-1).name, stations[0].name];
    entries.push({ rel, t: { from: ends[0], to: ends[1], name: cfg.brt.name }, ref: "BHNS", isBrt: true, seqIdx, tr, alsa: true, fare: cfg.brt.fare, headway: cfg.brt.headwayMin, hours: cfg.brt.firstBus || cfg.brt.lastBus ? { first: cfg.brt.firstBus, last: cfg.brt.lastBus } : undefined });
    // For the OSM draft: platforms in order and the ways between them.
    report.brtDraft = [...(report.brtDraft ?? []), { from: ends[0], to: ends[1], platforms: seqIdx.map((si) => stops[si].id), ways: tr?.wayIds ?? [] }];
    if (tr) report.sides.push({ rel: rel.id, ref: "BHNS", clean: tr.share <= SCRAMBLED, ...rightSide(tr) });
  }
  report.brt = { stations: stations.length, of: cfg.brt.stations.length, busways: busways.length };
}

// ---- Grands taxis: shared taxis from their stands, from a list kept by hand ----
// data/taxis/<city>-grands-taxis.csv: stand, stand_lat, stand_lon, osm, to,
// price_dh, to_lat, to_lon, both_ways, notes. Rows without a price are skipped.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
let taxiStopId = 9e12;
function addPointStop(name, ll) {
  const near = stops.findIndex((s) => s.src === "taxi" && s.n.d === name && dist(s.ll, ll) < 30);
  if (near >= 0) return near;
  stops.push({ id: taxiStopId++, src: "taxi", ll: [round5(ll[0]), round5(ll[1])], n: names({ name }) });
  return stops.length - 1;
}
if (cfg.grandsTaxis) {
  const text = await readFile(cfg.grandsTaxis, "utf8").catch(() => "");
  const rows = text ? parseCsv(text).filter((r) => Number(r.price_dh) > 0) : [];
  report.grandsTaxis = { rows: rows.length, skipped: [] };
  rows.forEach((r, k) => {
    if (!r.stand_lat || !r.stand_lon) {
      report.grandsTaxis.skipped.push(`${r.stand} → ${r.to}: stand position missing`);
      return;
    }
    const from = [Number(r.stand_lon), Number(r.stand_lat)];
    let to = r.to_lat && r.to_lon ? [Number(r.to_lon), Number(r.to_lat)] : null;
    if (!to) {
      // The destination town or neighbourhood of that name nearest the stand.
      const key = normKey(r.to);
      const cand = places.filter((p) => (p.k === "town" || p.k === "area") && (normKey(p.n.d) === key || normKey(p.n.fr) === key));
      to = cand.sort((a, b) => dist(a.ll, from) - dist(b.ll, from))[0]?.ll ?? null;
    }
    if (!to || !r.to) {
      report.grandsTaxis.skipped.push(`${r.stand} → ${r.to}: destination not found`);
      return;
    }
    const a = addPointStop(r.stand, from), b = addPointStop(r.to, to);
    const fare = { kind: "flat", normal: Number(r.price_dh), perSeat: true };
    for (const dir of r.both_ways === "no" ? [[a, b]] : [[a, b], [b, a]]) {
      const rel = { id: `taxi:${k}:${dir[0]}`, members: [] };
      const tr = trace(rel, dir);
      entries.push({ rel, t: { from: stops[dir[0]].n.d, to: stops[dir[1]].n.d, name: `Grand taxi ${r.stand} – ${r.to}` }, ref: `GT${k}`, isBrt: false, taxi: true, seqIdx: dir, tr, alsa: true, fare, colour: "#5f6b76" });
    }
  });
}

// Repair directions whose stop order is scrambled in OSM, and keep the repair
// only if it checks out better than what OSM has.
for (const e of entries) {
  if (e.alsa || !e.tr || e.tr.share <= SCRAMBLED) continue;
  const opposite = entries.find((o) => o !== e && o.ref === e.ref && o.tr && o.tr.share <= 0.1);
  const order = opposite ? orderAlong(e.seqIdx, [...opposite.tr.coords].reverse()) : orderChain(e.seqIdx, ...terminals(e.seqIdx, null, e.t));
  let fixed = trace(e.rel, order);
  // Stops belong on the right of the street; mostly-left means the chain runs backwards.
  let side = rightSide(fixed);
  let flipped = false;
  if (side.n >= 4 && side.share < 0.35) {
    const back = trace(e.rel, [...order].reverse());
    const backSide = rightSide(back);
    if (backSide.share > side.share) {
      fixed = back;
      side = backSide;
      flipped = true;
      order.reverse();
    }
  }
  report.reordered.push({ rel: e.rel.id, ref: e.ref, name: e.t.name, method: opposite ? "opposite" : "chain", flipped, right: Math.round(side.share * 100) / 100, before: Math.round(e.tr.share * 100) / 100, after: Math.round(fixed.share * 100) / 100, order: order.map((si) => stops[si].id) });
  if (fixed.share < e.tr.share) {
    e.tr = fixed;
    e.inferred = opposite ? "opposite" : "chain";
  }
}

const byRef = new Map();
for (const e of entries) {
  const { rel, t, ref, isBrt } = e;
  let coords, seq;
  let breaks = [];
  if (e.tr) {
    const tr = e.tr;
    breaks = tr.breaks;
    tr.breaks.forEach((k, i) =>
      report.untrusted.push({ rel: rel.id, ref, k, from: stops[tr.seqIdx[k]].n.d ?? null, to: stops[tr.seqIdx[k + 1]].n.d ?? null, passes: tr.passes[i].map((si) => stops[si].n.d ?? null).slice(0, 6) }),
    );
    if (tr.straight) report.gaps.push({ rel: rel.id, ref, straightLegs: tr.straight, of: tr.seqIdx.length - 1 });
    coords = tr.coords;
    seq = tr.seqIdx.map((si, k) => ({ s: si, a: Math.round(tr.along[k]) }));
  } else {
    const asm = assembleShape(rel);
    if (asm.gaps) report.gaps.push({ rel: rel.id, ref, wayGaps: asm.gaps });
    coords = asm.coords;
    const cum = cumulative(coords);
    let seg = 0;
    seq = e.seqIdx.map((si) => {
      const pr = coords.length > 1 ? project(coords, cum, stops[si].ll, seg) : { along: 0, offset: 0, seg: 0 };
      seg = pr.seg;
      return { s: si, a: Math.round(pr.along) };
    });
  }
  const cum = cumulative(coords);
  if (seq.length < 2) report.noStops.push({ rel: rel.id, ref, name: t.name, stops: seq.length });
  const variant = {
    rel: rel.id,
    from: t.from ?? "",
    to: t.to ?? "",
    shape: coords.map(([x, y]) => [round5(x), round5(y)]),
    stops: seq.map((x) => x.s),
    along: seq.map((x) => x.a),
    length: Math.round(cum.at(-1) ?? 0),
    ...(breaks.length ? { breaks } : {}),
    ...(e.inferred ? { inferred: e.inferred } : {}),
  };
  if (e.fare?.kind === "zones" && e.tr) {
    // City end of the line: the outgoing direction's first stop.
    const outgoing = entries.find((o) => o.ref === ref && o.alsa && String(o.rel.id).endsWith(":outgoing"));
    const z = zonesFor(e.tr.seqIdx, e.fare, stops[(outgoing ?? e).seqIdx[0]].ll);
    if (z) variant.zones = z;
    else report.zoneless = [...(report.zoneless ?? []), `${ref}:${t.to}`];
  }
  if (!byRef.has(ref)) byRef.set(ref, { ref, brt: isBrt, name: t.name, variants: [], ...(e.fare ? { fare: e.fare } : {}), ...(e.colour ? { colour: e.colour } : {}), ...(e.headway ? { headway: e.headway } : {}), ...(e.hours ? { hours: e.hours } : {}), ...(e.taxi ? { taxi: true } : {}) });
  byRef.get(ref).variants.push(variant);
}

const order = (l) => (l.brt ? -1 : l.taxi ? 10_000 : parseInt(l.ref) || 999);
const lines = [...byRef.values()].sort((a, b) => order(a) - order(b));
// The Trambus in Amalway's orange (beta.amalway.ma); bus lines keep ALSA's colours.
lines.forEach((l, i) => (l.colour = l.brt ? "#ed6c36" : (l.colour ?? PALETTE[i % PALETTE.length])));
for (const l of lines) if (l.taxi) l.variants.forEach((v) => (v.inferred = undefined));

// Each place's nearest other town, to tell apart places with the same name.
places.forEach((p, i) => {
  let best = -1, bestD = 20_000;
  places.forEach((q, j) => {
    if (j === i || (q.k !== "town" && !(p.k !== "area" && p.k !== "town" && q.k === "area")) || q.n.d === p.n.d) return;
    const d = dist(p.ll, q.ll);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  });
  if (best >= 0) p.in = best;
});

// "Near" label for each stop: the closest landmark within 350 m, and its area.
for (const s of stops) {
  let near = null, nearD = 350, area = null, areaD = 2500;
  for (const p of places) {
    const d = dist(s.ll, p.ll);
    // Landmarks people recognise: OSM places of a kind you'd give directions by.
    const bigShop = p.k === "shop" && /mall|supermarket|department_store|marketplace/.test(p.t ?? "");
    if (p.k === "street" || p.src === "ov" || p.k === "food" || p.k === "bank" || p.k === "poi" || (p.k === "shop" && !bigShop)) continue;
    if (p.k === "area" || p.k === "town") {
      if (d < areaD) {
        areaD = d;
        area = p;
      }
    } else if (d < nearD) {
      nearD = d;
      near = p;
    }
  }
  if (near) s.near = places.indexOf(near);
  if (area) s.area = places.indexOf(area);
}

// Stops that no line uses can't be routed through; keep only used ones.
const out = {
  city: cfg.id,
  name: cfg.name,
  bbox: cfg.bbox,
  center: cfg.center,
  zoom: cfg.zoom,
  osmTimestamp: routesRaw.osm3s?.timestamp_osm_base,
  ...(cfg.petitTaxi ? { petitTaxi: { start: cfg.petitTaxi.start, perKm: cfg.petitTaxi.perKm, minFare: cfg.petitTaxi.minFare, night: cfg.petitTaxi.night, nightFrom: cfg.petitTaxi.nightFrom, nightTo: cfg.petitTaxi.nightTo } } : {}),
  communes,
  ...(cfg.airportTaxi ? { airportTaxi: { at: cfg.airportTaxi.at, radius: cfg.airportTaxi.radius, fares: cfg.airportTaxi.fares } } : {}),
  ...(alsa ? { alsaFetched: (await readFile(`${ALSA_DIR}/fetched-at.txt`, "utf8").catch(() => "")).trim() || undefined } : {}),
  stops,
  places,
  lines,
};
await mkdir("public/data", { recursive: true });
const json = JSON.stringify(out);
await writeFile(`public/data/${city}.json`, json);
await mkdir(`data/reports`, { recursive: true });
await writeFile(`data/reports/${city}.json`, JSON.stringify(report, null, 2));
const variants = lines.reduce((n, l) => n + l.variants.length, 0);
const routable = lines.filter((l) => l.variants.some((v) => v.stops.length >= 2)).length;
console.log(`${lines.length} lines (${routable} with stops), ${variants} directions, ${stops.length} stops, ${places.length} places`);
console.log(`${report.reordered.filter((r) => r.after < r.before).length} of ${report.reordered.length} scrambled directions repaired`);
console.log(`${report.untrusted.length} untrusted sections (stop order wrong), in ${new Set(report.untrusted.map((u) => u.rel)).size} directions`);
console.log(`${(json.length / 1024).toFixed(0)} KiB; shape gaps in ${report.gaps.length} directions, ${report.noStops.length} directions without stops, ${report.farStops.length} stops >150 m off their path`);
