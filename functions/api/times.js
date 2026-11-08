// Cloudflare Pages Function: ride times that riders chose to share (Settings → "Share my ride times").
//
//   POST /api/times   { v: 1, items: [ { k: "hop" | "wait", l, v, a, b?, s, d, h, w } ] }
//   GET  /api/times   medians per stop-to-stop hop (and per stop for waits), only where enough rides agree
//
// Stored: the line, direction, stop ids, seconds, day, hour and weekday. Nothing about who sent it:
// no IP, no device id, no position. Kept in the D1 database bound as DB (see wrangler.toml).

const MAX_ITEMS = 200;
const MIN_RIDES = 5; // a median needs at least this many rides…
const MIN_DAYS = 3; // …on at least this many different days

const json = (body, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": cache } });

const ID = /^[A-Za-z0-9:_-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A record as sent by the app, or null when anything about it is off. */
export function clean(x, today = new Date()) {
  if (!x || typeof x !== "object") return null;
  const { k, l, v, a, b, s, d, h, w } = x;
  if (k !== "hop" && k !== "wait") return null;
  if (typeof l !== "string" || !/^[A-Z0-9]{1,6}$/.test(l)) return null;
  if (typeof v !== "string" || !ID.test(v) || typeof a !== "string" || !ID.test(a)) return null;
  if (k === "hop" && (typeof b !== "string" || !ID.test(b) || b === a)) return null;
  if (!Number.isInteger(s) || s < (k === "hop" ? 5 : 0) || s > (k === "hop" ? 1800 : 3600)) return null;
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(w) || w < 0 || w > 6) return null;
  if (typeof d !== "string" || !DAY.test(d)) return null;
  // Recent rides only: not in the future, not older than two weeks (a queue kept that long offline).
  const age = (today.getTime() - new Date(`${d}T12:00:00Z`).getTime()) / 86_400_000;
  if (age < -1 || age > 14) return null;
  return { k, l, v, a, b: k === "hop" ? b : null, s, d, h, w };
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "not set up" }, 503);
  const text = await request.text();
  if (text.length > 64_000) return json({ error: "too big" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (body?.v !== 1 || !Array.isArray(body.items) || body.items.length > MAX_ITEMS) return json({ error: "bad batch" }, 400);
  const rows = body.items.map((x) => clean(x)).filter(Boolean);
  if (rows.length) {
    const ins = env.DB.prepare("INSERT INTO times (k, line, dir, a, b, s, day, hour, wday) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    await env.DB.batch(rows.map((r) => ins.bind(r.k, r.l, r.v, r.a, r.b, r.s, r.d, r.h, r.w)));
  }
  // Records that didn't pass are dropped, not refused: the app can't fix them by sending again.
  return json({ kept: rows.length, dropped: body.items.length - rows.length });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Medians where enough rides on enough days agree; nothing else leaves the database. */
export function summarise(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.k}|${r.line}|${r.dir}|${r.a}|${r.b ?? ""}`;
    if (!groups.has(key)) groups.set(key, { k: r.k, line: r.line, dir: r.dir, a: r.a, b: r.b ?? undefined, s: [], days: new Set() });
    const g = groups.get(key);
    g.s.push(r.s);
    g.days.add(r.day);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.s.length < MIN_RIDES || g.days.size < MIN_DAYS) continue;
    out.push({ k: g.k, line: g.line, dir: g.dir, a: g.a, ...(g.b ? { b: g.b } : {}), median: median(g.s), rides: g.s.length, days: g.days.size });
  }
  return out;
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "not set up" }, 503);
  // The last six months: a line that changed shouldn't keep its old times forever.
  const { results } = await env.DB.prepare("SELECT k, line, dir, a, b, s, day FROM times WHERE day >= date('now', '-183 days')").all();
  return json({ since: "183 days", minRides: MIN_RIDES, minDays: MIN_DAYS, items: summarise(results) }, 200, "public, max-age=3600");
}
