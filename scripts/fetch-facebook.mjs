// Fetches ALSA Agadir's latest Facebook posts into the council's inbox, through Apify's Facebook
// Posts Scraper (the page has no open feed; Apify's free plan covers a monthly run). Needs an Apify
// API token in APIFY_TOKEN.
//
//   APIFY_TOKEN=... node scripts/fetch-facebook.mjs [how many posts, default 15] [only posts since YYYY-MM-DD]
//
// Keeps only what the inbox reads: each post's text, link, date and pictures. Commenters' names and
// profiles never reach the disk.
import { writeFile, mkdir } from "node:fs/promises";

const PAGE = "https://www.facebook.com/ALSA.Agadir.officielle";
const OUT = "data/council/inbox/alsa-facebook-latest.json";
const token = process.env.APIFY_TOKEN;
if (!token) throw new Error("set APIFY_TOKEN (Apify console → Settings → API & Integrations)");
const limit = Number(process.argv[2] || 15);
const since = process.argv[3];
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`"${since}" isn't a date (YYYY-MM-DD)`);

// Start the scrape, wait for it (a few hundred posts can take longer than a held-open request lasts),
// then read what it found.
const api = (path, init = {}) => fetch(`https://api.apify.com/v2${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) });
const started = await api("/acts/apify~facebook-posts-scraper/runs", { method: "POST", body: JSON.stringify({ startUrls: [{ url: PAGE }], resultsLimit: limit, ...(since ? { onlyPostsNewerThan: since } : {}) }) });
if (!started.ok) throw new Error(`Apify answered ${started.status}: ${(await started.text()).slice(0, 300)}`);
let run = (await started.json()).data;
const until = Date.now() + 25 * 60_000;
while (["READY", "RUNNING"].includes(run.status)) {
  if (Date.now() > until) throw new Error(`the scrape (${run.id}) is still running after 25 minutes`);
  await new Promise((r) => setTimeout(r, 10_000));
  run = (await (await api(`/actor-runs/${run.id}`)).json()).data;
}
if (run.status !== "SUCCEEDED") throw new Error(`the scrape (${run.id}) ended ${run.status}`);
const items = await (await api(`/datasets/${run.defaultDatasetId}/items?clean=true`)).json();
const posts = items
  .filter((p) => p.url && p.time)
  .map((p) => ({
    url: String(p.url).split("?")[0],
    time: p.time,
    text: p.text ?? "",
    media: (p.media ?? []).map((m) => ({ photo_image: { uri: m.photo_image?.uri ?? m.thumbnail } })).filter((m) => m.photo_image.uri),
  }));
await mkdir("data/council/inbox", { recursive: true });
await writeFile(OUT, JSON.stringify(posts, null, 2) + "\n");
console.log(`${posts.length} posts → ${OUT}`);
