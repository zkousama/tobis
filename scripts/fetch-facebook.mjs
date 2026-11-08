// Fetches the operators' Facebook posts into the council's inbox, through Apify's Facebook Posts
// Scraper (the pages have no open feed; Apify's free plan covers a monthly run). Needs an Apify API
// token in APIFY_TOKEN.
//
//   APIFY_TOKEN=... node scripts/fetch-facebook.mjs [posts per window, default 30] [since YYYY-MM-DD, default 60 days ago]
//
// Logged out, Facebook shows only part of a page's history per visit, so one long read skips posts.
// This reads the time since `since` in windows of three months, each page and window on its own, and
// merges what comes back. It then says how many of the posts the claims already cite it found again:
// that is how complete the read was.
//
// Keeps only what the inbox reads: each post's page, text, permanent link, time and pictures.
// Commenters' names and profiles never reach the disk.
import { readFileSync, existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";

export const PAGES = [
  { name: "ALSA Facebook", url: "https://www.facebook.com/ALSA.Agadir.officielle" },
  { name: "Amalway Facebook", url: "https://www.facebook.com/amalwayofficiel" },
];
const OUT = "data/council/inbox/facebook-latest.json";
const day = (d) => d.toISOString().slice(0, 10);

/** Three-month windows from `since` to tomorrow, newest first. */
export function windows(since, now = new Date()) {
  const end = new Date(now.getTime() + 86_400_000);
  const out = [];
  for (let to = end; to > since; ) {
    const from = new Date(to);
    from.setUTCMonth(from.getUTCMonth() - 3);
    out.push({ from: day(from < since ? since : from), to: day(to) });
    to = from;
  }
  return out;
}

/** An Apify item as the inbox keeps it; the permanent link survives Facebook's per-visit links. */
export function keep(p, page) {
  const permanent = p.facebookId && p.postId ? `https://www.facebook.com/${p.facebookId}/posts/${p.postId}` : String(p.url ?? "").split("?")[0];
  return {
    page,
    url: permanent,
    time: p.time,
    text: p.text ?? "",
    media: (p.media ?? []).map((m) => ({ photo_image: { uri: m.photo_image?.uri ?? m.thumbnail } })).filter((m) => m.photo_image.uri),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("set APIFY_TOKEN (Apify console → Settings → API & Integrations)");
  const limit = Number(process.argv[2] || 30);
  const sinceArg = process.argv[3];
  if (sinceArg && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) throw new Error(`"${sinceArg}" isn't a date (YYYY-MM-DD)`);
  const since = sinceArg ? new Date(`${sinceArg}T00:00:00Z`) : new Date(Date.now() - 60 * 86_400_000);

  const api = (path, init = {}) =>
    fetch(`https://api.apify.com/v2${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) });
  // One scrape: start it, wait (a long read outlasts a held-open request), read what it found.
  async function scrape(page, w) {
    const input = { startUrls: [{ url: page.url }], resultsLimit: limit, onlyPostsNewerThan: w.from, onlyPostsOlderThan: w.to };
    const started = await api("/acts/apify~facebook-posts-scraper/runs", { method: "POST", body: JSON.stringify(input) });
    if (!started.ok) throw new Error(`Apify answered ${started.status}: ${(await started.text()).slice(0, 300)}`);
    let run = (await started.json()).data;
    const until = Date.now() + 20 * 60_000;
    while (["READY", "RUNNING"].includes(run.status)) {
      if (Date.now() > until) throw new Error(`the scrape (${run.id}) is still running after 20 minutes`);
      await new Promise((r) => setTimeout(r, 10_000));
      run = (await (await api(`/actor-runs/${run.id}`)).json()).data;
    }
    if (run.status !== "SUCCEEDED") throw new Error(`the scrape (${run.id}) ended ${run.status}`);
    const items = await (await api(`/datasets/${run.defaultDatasetId}/items?clean=true`)).json();
    return items.filter((p) => p.time && (p.postId || p.url)).map((p) => keep(p, page.name));
  }

  const jobs = PAGES.flatMap((page) => windows(since).map((w) => ({ page, w })));
  const byTime = new Map();
  // A few at a time: the free plan's memory caps how many scrapes run at once.
  for (let i = 0; i < jobs.length; i += 3) {
    const got = await Promise.all(jobs.slice(i, i + 3).map(async ({ page, w }) => {
      const posts = await scrape(page, w);
      console.log(`${page.name} ${w.from} → ${w.to}: ${posts.length} posts`);
      return posts;
    }));
    for (const p of got.flat()) byTime.set(`${p.page} ${p.time}`, p);
  }
  const posts = [...byTime.values()].sort((a, b) => b.time.localeCompare(a.time));
  await mkdir("data/council/inbox", { recursive: true });
  await writeFile(OUT, JSON.stringify(posts, null, 2) + "\n");

  // How complete the read was: the posts the claims cite (or set aside) in that time, found again.
  if (existsSync("data/council/claims.json")) {
    const { claims, ignored = [] } = JSON.parse(readFileSync("data/council/claims.json", "utf8"));
    const known = new Set([...claims.map((c) => c.source.posted), ...ignored.map((x) => x.posted)].filter((t) => t && new Date(t) >= since));
    const found = posts.filter((p) => known.has(p.time)).length;
    console.log(`found again ${found} of the ${known.size} known posts since ${day(since)}`);
  }
  console.log(`${posts.length} posts → ${OUT}`);
}
