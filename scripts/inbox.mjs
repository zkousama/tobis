// The council's inbox: what the operator posted goes in data/council/inbox/, as an export of the page's
// posts (JSON: a list of { text, url, time, media }, the shape Apify's Facebook posts scraper writes),
// screenshots (read with OCR, in French, Arabic and English) or text pasted into a .txt. This drafts the
// claims each post seems to make and waits for a person to check them.
//
//   node scripts/inbox.mjs                       read the inbox, write a draft per post in data/council/drafts/
//   node scripts/inbox.mjs --approve <draft>     after filling in the TODOs: add its claims to claims.json
//   node scripts/inbox.mjs --ignore <draft> "why" a post with nothing for the data (a night service, an ad)
//
// The inbox, drafts and kept evidence stay on this machine (gitignored); the claims keep the post's link.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { extract, todo } from "./inbox-extract.mjs";
import { TRUST } from "./council.mjs";

const DIR = "data/council";
const INBOX = `${DIR}/inbox`, DRAFTS = `${DIR}/drafts`, EVIDENCE = `${DIR}/evidence`;
for (const d of [INBOX, DRAFTS, EVIDENCE, `${DIR}/.ocr-cache`]) mkdirSync(d, { recursive: true });

const args = process.argv.slice(2);
if (args[0] === "--approve") approve(args[1]);
else if (args[0] === "--ignore") ignore(args[1], args.slice(2).join(" "));
else await read();

async function read() {
  const files = readdirSync(INBOX).filter((f) => /\.(png|jpe?g|webp|txt)$/i.test(f));
  const exports = readdirSync(INBOX).filter((f) => /\.json$/i.test(f));
  if (!files.length && !exports.length) return console.log(`Nothing in ${INBOX}/. Put an export of the page's posts there, screenshots of posts, or their text in a .txt.`);
  const net = JSON.parse(readFileSync("public/data/agadir.json", "utf8"));
  const known = { lines: net.lines.map((l) => l.ref), stops: net.stops.map((s) => s.n.d).filter(Boolean) };
  for (const f of exports) readExport(f, known);
  let ocr;
  for (const f of files) {
    const path = join(INBOX, f);
    let text;
    if (extname(f).toLowerCase() === ".txt") text = readFileSync(path, "utf8");
    else {
      // French and Arabic posts, often both in one picture.
      // The language models download once, into a cache next to the inbox (gitignored).
      ocr ??= await (await import("tesseract.js")).createWorker(["fra", "ara", "eng"], 1, { cachePath: `${DIR}/.ocr-cache` });
      text = (await ocr.recognize(path)).data.text;
    }
    const found = extract(text, known);
    const draft = { file: f, ...found, text };
    const out = join(DRAFTS, `${basename(f, extname(f))}.json`);
    writeFileSync(out, JSON.stringify(draft, null, 2) + "\n");
    console.log(`${f}: lines ${found.lines.join(", ") || "none"} · ${found.kinds.join(", ") || "no change words"} · ${found.stops.length} stops · ${found.claims.length} draft claim(s) → ${out}`);
  }
  await ocr?.terminate();
  console.log(`\nCheck each draft against its picture, fill in the TODOs (the post's link and date, the change in fr/ar/en), then: node scripts/inbox.mjs --approve <draft>`);
}

/** An export of the page's posts: one draft per post the claims don't cite yet. */
function readExport(f, known) {
  const posts = JSON.parse(readFileSync(join(INBOX, f), "utf8"));
  if (!Array.isArray(posts)) return console.log(`${f}: not a list of posts, skipped`);
  const { claims, ignored = [] } = JSON.parse(readFileSync(`${DIR}/claims.json`, "utf8"));
  const cited = new Set([...claims.map((c) => c.source.url), ...ignored.map((i) => i.url)].filter(Boolean));
  let fresh = 0;
  for (const p of posts) {
    const url = String(p.url ?? "").split("?")[0];
    const date = String(p.time ?? "").slice(0, 10);
    if (!p.text || !url || cited.has(url)) continue;
    const found = extract(p.text, known);
    // The post itself gives the link and the day; what it says still needs a person.
    for (const c of found.claims) c.source = { ...c.source, url, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : c.source.date };
    // Fare grids and maps are pictures: their links go with the draft, to look at.
    const pictures = (p.media ?? []).map((m) => m.photo_image?.uri ?? m.thumbnail).filter(Boolean);
    const id = url.split("/").pop().slice(0, 24);
    const out = join(DRAFTS, `${date}-${id}.json`);
    writeFileSync(out, JSON.stringify({ file: f, post: url, ...found, pictures, text: p.text }, null, 2) + "\n");
    console.log(`${date}: lines ${found.lines.join(", ") || "none"} · ${found.kinds.join(", ") || "no change words"} · ${pictures.length} picture(s) · ${found.claims.length} draft claim(s) → ${out}`);
    fresh++;
  }
  console.log(`${f}: ${posts.length} posts, ${fresh} not yet in the claims or set aside`);
}

function approve(path) {
  if (!path || !existsSync(path)) throw new Error(`no draft at ${path}`);
  const draft = JSON.parse(readFileSync(path, "utf8"));
  const left = todo(draft.claims);
  if (left.length) throw new Error(`fill these in first:\n  ${left.join("\n  ")}`);
  if (!draft.claims.length) throw new Error("this draft has no claims");
  for (const c of draft.claims) {
    if (!(c.source?.type in TRUST) || !c.source.name || !c.source.date) throw new Error(`${c.fact}: needs a source with a known type, a name and a date`);
    if (c.fact.endsWith(":route")) for (const l of ["fr", "ar", "en"]) if (!c.value?.[l]) throw new Error(`${c.fact}: needs the change in ${l}`);
  }
  const file = `${DIR}/claims.json`;
  const all = JSON.parse(readFileSync(file, "utf8"));
  all.claims.push(...draft.claims.map(({ stops, ...c }) => ({ ...c, ...(stops ? { note: `${c.note ? `${c.note}; ` : ""}stops named: ${stops.join(", ")}` } : {}) })));
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  if (!draft.post && existsSync(join(INBOX, draft.file))) renameSync(join(INBOX, draft.file), join(EVIDENCE, draft.file));
  renameSync(path, join(EVIDENCE, basename(path)));
  console.log(`${draft.claims.length} claim(s) added to ${file}; the picture and draft are kept in ${EVIDENCE}/. Rebuild the data to let the council weigh them.`);
}

/** A post read and set aside: kept in the claims file with the reason, so it isn't drafted again. */
function ignore(path, why) {
  if (!path || !existsSync(path)) throw new Error(`no draft at ${path}`);
  if (!why) throw new Error('say why, e.g. --ignore <draft> "night service for a match"');
  const draft = JSON.parse(readFileSync(path, "utf8"));
  if (!draft.post) throw new Error("only posts from an export can be set aside; delete a screenshot instead");
  const file = `${DIR}/claims.json`;
  const all = JSON.parse(readFileSync(file, "utf8"));
  all.ignored = [...(all.ignored ?? []), { url: draft.post, date: draft.claims[0]?.source.date ?? basename(path).slice(0, 10), why }];
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  renameSync(path, join(EVIDENCE, basename(path)));
  console.log(`set aside: ${draft.post}`);
}
