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
      if (d > bestD) (bestD = d), (best = i);
    }
    if (best > 0) (keep[best] = 1), stack.push([a, best], [best, b]);
  }
  return pts.filter((_, i) => keep[i]);
}

// Follow the streets from stop to stop, preferring the ways the relation lists.
function traceStops(rel, stopLLs) {
  const relWays = new Set(rel.members.filter((m) => m.type === "way").map((m) => m.ref));
  const weight = (e) => (relWays.has(e.way) ? 1 : 2.5);
  const coords = [stopLLs[0]];
  const along = [0];
  const legStats = [];
  let straight = 0;
  for (let i = 0; i < stopLLs.length - 1; i++) {
    const a = stopLLs[i], b = stopLLs[i + 1];
    const crow = dist(a, b);
    const seeds = (p) => graph.near(p, 90, "drive").slice(0, 8).map((x) => ({ i: x.i, cost: x.d * 2 }));
    const res = graph.path(seeds(a), seeds(b), "drive", weight, crow * 5 + 2000);
    let leg;
    let onRel = 0;
    if (res && res.metres < crow * 4 + 1500) {
      leg = [...res.nodes.map((n) => graph.coord[n]), b];
      // How much of this stretch runs on ways the relation itself lists.
      for (let k = 1; k < res.nodes.length; k++) {
        const e = graph.adj[res.nodes[k - 1]].find((x) => x.to === res.nodes[k]);
        if (e && relWays.has(e.way)) onRel += e.len;
      }
      onRel /= Math.max(1, res.metres);
    } else (leg = [b], straight++);
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
  return { coords, along, straight, legStats };
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
    if (sc !== cur) (flush(), (cur = sc));
    buf += " " + word;
  }
  flush();
  return { latn: parts.latn.join(" "), arab: parts.arab.join(" "), tfng: parts.tfng.join(" ") };
}
function names(t = {}) {
  const n = {};
  for (const k of ["name", "name:fr", "name:ar", "name:en", "name:zgh"]) if (t[k] && !NUMERIC.test(t[k])) n[k === "name" ? "d" : k.slice(5)] = t[k].trim();
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
  t.place ? (["city", "town", "village", "hamlet"].includes(t.place) ? "town" : "area")
  : t.aeroway ? "airport"
  : t.amenity === "bus_station" ? "station"
  : t.amenity === "university" || t.amenity === "college" ? "school"
  : t.amenity === "hospital" || t.amenity === "clinic" ? "health"
  : t.shop ? "shop"
  : t.tourism === "hotel" ? "hotel"
  : t.leisure ? "leisure"
  : "poi";
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
  places.push({ ll: [round5(lon), round5(lat)], n, k: KIND(t) });
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
    if (passed.size >= 2) (breaks.push(k), passes.push([...passed]));
  });
  return { breaks, passes };
}

function trace(rel, seqIdx) {
  if (!graph || seqIdx.length < 2) return null;
  const tr = traceStops(rel, seqIdx.map((i) => stops[i].ll));
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
    if (cost < bestCost) (bestCost = cost), (best = k);
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
      if (d < nd) (nd = d), (nb = s);
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
  for (const a of seqIdx) for (const b of seqIdx) { const d = dist(stops[a].ll, stops[b].ll); if (d > far) (far = d), (A = a), (B = b); }
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
function zonesFor(seqIdx, fare) {
  const anchors = fare.zones.map((z) => {
    const key = normKey(z.fr);
    const byStop = seqIdx.filter((si) => normKey(stops[si].n.d).includes(key));
    if (byStop.length) return stops[byStop[0]].ll;
    const pl = places.filter((p) => normKey(p.n.d) === key || normKey(p.n.fr) === key);
    if (!pl.length) return null;
    // The place of that name closest to this line.
    return pl.reduce((b, p) => (Math.min(...seqIdx.map((si) => dist(stops[si].ll, p.ll))) < Math.min(...seqIdx.map((si) => dist(stops[si].ll, b.ll))) ? p : b)).ll;
  });
  if (anchors.some((a) => !a)) return undefined;
  return seqIdx.map((si) => anchors.reduce((best, a, i) => (dist(stops[si].ll, a) < dist(stops[si].ll, anchors[best]) ? i : best), 0));
}

if (alsa) {
  for (const l of alsa.lines) {
    const ref = l.id.replace(/^L-?/, "");
    const fare = parseFare(alsaDetails[l.id]?.tarifa);
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
      const t = { from: cleanName(dir.lineHeader), to: cleanName(dir.lineEnd), name: cleanName(l.surname.replace(/^[^A-Z]*:\s*/, "")) };
      entries.push({ rel, t, ref, isBrt: false, seqIdx, tr, alsa: true, fare, colour: `#${String(l.color).replace("#", "")}` });
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
        if (sc > bestS) (bestS = sc), (best = nodesOf);
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
      for (const st of left) { const d = dist(ll(cur), ll(st)); if (d < nd) (nd = d), (nb = st); }
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
    const tr = trace(rel, seqIdx);
    const ends = forward ? [stations[0].name, stations.at(-1).name] : [stations.at(-1).name, stations[0].name];
    entries.push({ rel, t: { from: ends[0], to: ends[1], name: cfg.brt.name }, ref: "BHNS", isBrt: true, seqIdx, tr, alsa: true, fare: cfg.brt.fare, headway: cfg.brt.headwayMin });
    if (tr) report.sides.push({ rel: rel.id, ref: "BHNS", clean: tr.share <= SCRAMBLED, ...rightSide(tr) });
  }
  report.brt = { stations: stations.length, of: cfg.brt.stations.length, busways: busways.length };
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
    if (backSide.share > side.share) ((fixed = back), (side = backSide), (flipped = true), order.reverse());
  }
  report.reordered.push({ rel: e.rel.id, ref: e.ref, name: e.t.name, method: opposite ? "opposite" : "chain", flipped, right: Math.round(side.share * 100) / 100, before: Math.round(e.tr.share * 100) / 100, after: Math.round(fixed.share * 100) / 100, order: order.map((si) => stops[si].id) });
  if (fixed.share < e.tr.share) (e.tr = fixed), (e.inferred = opposite ? "opposite" : "chain");
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
    const z = zonesFor(e.tr.seqIdx, e.fare);
    if (z) variant.zones = z;
    else report.zoneless = [...(report.zoneless ?? []), `${ref}:${t.to}`];
  }
  if (!byRef.has(ref)) byRef.set(ref, { ref, brt: isBrt, name: t.name, variants: [], ...(e.fare ? { fare: e.fare } : {}), ...(e.colour ? { colour: e.colour } : {}), ...(e.headway ? { headway: e.headway } : {}) });
  byRef.get(ref).variants.push(variant);
}

const lines = [...byRef.values()].sort((a, b) => (a.brt ? -1 : b.brt ? 1 : (parseInt(a.ref) || 999) - (parseInt(b.ref) || 999)));
lines.forEach((l, i) => (l.colour ??= l.brt ? "#00a19a" : PALETTE[i % PALETTE.length]));

// Each place's nearest other town, to tell apart places with the same name.
places.forEach((p, i) => {
  let best = -1, bestD = 20_000;
  places.forEach((q, j) => {
    if (j === i || q.k !== "town" || q.n.d === p.n.d) return;
    const d = dist(p.ll, q.ll);
    if (d < bestD) (bestD = d), (best = j);
  });
  if (best >= 0) p.in = best;
});

// "Near" label for each stop: the closest landmark within 350 m, and its area.
for (const s of stops) {
  let near = null, nearD = 350, area = null, areaD = 2500;
  for (const p of places) {
    const d = dist(s.ll, p.ll);
    if (p.k === "area" || p.k === "town") {
      if (d < areaD) (areaD = d), (area = p);
    } else if (d < nearD) (nearD = d), (near = p);
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
