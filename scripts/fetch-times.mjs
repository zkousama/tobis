// Downloads the ride times riders shared (medians only, where enough rides agree) from the live
// site into data/council/measured.json, for the build to compare with its estimates.
//
//   node scripts/fetch-times.mjs [site, default https://tobis.pages.dev]
import { writeFile } from "node:fs/promises";

const site = process.argv[2] ?? "https://tobis.pages.dev";
const res = await fetch(`${site}/api/times`, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) throw new Error(`${site}/api/times answered ${res.status}${res.status === 503 ? " (the database isn't bound yet)" : ""}`);
const body = await res.json();
await writeFile("data/council/measured.json", JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), ...body }, null, 2) + "\n");
console.log(`${body.items.length} measured hops and waits → data/council/measured.json`);
