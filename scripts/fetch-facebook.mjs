// Fetches ALSA Agadir's latest Facebook posts into the council's inbox, through Apify's Facebook
// Posts Scraper (the page has no open feed; Apify's free plan covers a monthly run). Needs an Apify
// API token in APIFY_TOKEN.
//
//   APIFY_TOKEN=... node scripts/fetch-facebook.mjs [how many posts, default 15]
//
// Keeps only what the inbox reads: each post's text, link, date and pictures. Commenters' names and
// profiles never reach the disk.
import { writeFile, mkdir } from "node:fs/promises";

const PAGE = "https://www.facebook.com/ALSA.Agadir.officielle";
const OUT = "data/council/inbox/alsa-facebook-latest.json";
const token = process.env.APIFY_TOKEN;
if (!token) throw new Error("set APIFY_TOKEN (Apify console → Settings → API & Integrations)");
const limit = Number(process.argv[2] ?? 15);

const res = await fetch("https://api.apify.com/v2/acts/apify~facebook-posts-scraper/run-sync-get-dataset-items", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ startUrls: [{ url: PAGE }], resultsLimit: limit }),
  signal: AbortSignal.timeout(300_000),
});
if (!res.ok) throw new Error(`Apify answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
const items = await res.json();
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
