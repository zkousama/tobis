// Downloads the ride times riders shared (medians only, where enough rides agree) from the live
// site into data/council/measured.json, for the build to compare with its estimates.
//
//   TIMES_KEY=... node scripts/fetch-times.mjs [site, default https://tobis.pages.dev]
// TIMES_KEY is the secret set on the Pages project; without it the site answers 401.
import { writeFile } from "node:fs/promises";

const site = process.argv[2] ?? "https://tobis.pages.dev";
if (!process.env.TIMES_KEY) throw new Error("set TIMES_KEY (the secret on the Pages project)");
const res = await fetch(`${site}/api/times`, { headers: { authorization: `Bearer ${process.env.TIMES_KEY}` }, signal: AbortSignal.timeout(30_000) });
if (!res.ok) throw new Error(`${site}/api/times answered ${res.status}${res.status === 503 ? " (the database isn't bound yet)" : ""}`);
const body = await res.json();
await writeFile("data/council/measured.json", JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), ...body }, null, 2) + "\n");
console.log(`${body.items.length} measured hops and waits → data/council/measured.json`);
