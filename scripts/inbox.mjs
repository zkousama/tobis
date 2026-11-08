// The council's inbox: what the operator posted goes in data/council/inbox/ (scripts/fetch-facebook.mjs
// puts the latest posts there), as an export of the page's
// posts (JSON: a list of { text, url, time, media }, the shape Apify's Facebook posts scraper writes) or
// a post's text pasted into a .txt. This drafts the claims each post seems to make and waits for a person
// to check them. Fare grids and maps are pictures; a person reads those (OCR made nothing of them).
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
for (const d of [INBOX, DRAFTS, EVIDENCE]) mkdirSync(d, { recursive: true });

// With INBOX_REPORT=<file>: a list of the new posts, for the monthly check's issue.
const report = [];

const args = process.argv.slice(2);
if (args[0] === "--approve") approve(args[1]);
else if (args[0] === "--ignore") ignore(args[1], args.slice(2).join(" "));
else read();

function read() {
  const files = readdirSync(INBOX).filter((f) => /\.txt$/i.test(f));
  const exports = readdirSync(INBOX).filter((f) => /\.json$/i.test(f));
  if (!files.length && !exports.length) return console.log(`Nothing in ${INBOX}/. Put an export of the page's posts there, or a post's text in a .txt.`);
  const net = JSON.parse(readFileSync("public/data/agadir.json", "utf8"));
  const known = { lines: net.lines.map((l) => l.ref), stops: net.stops.map((s) => s.n.d).filter(Boolean) };
  for (const f of exports) readExport(f, known);
  for (const f of files) {
    const text = readFileSync(join(INBOX, f), "utf8");
    const found = extract(text, known);
    const draft = { file: f, ...found, text };
    const out = join(DRAFTS, `${basename(f, extname(f))}.json`);
    writeFileSync(out, JSON.stringify(draft, null, 2) + "\n");
    console.log(`${f}: lines ${found.lines.join(", ") || "none"} · ${found.kinds.join(", ") || "no change words"} · ${found.stops.length} stops · ${found.claims.length} draft claim(s) → ${out}`);
  }
  if (process.env.INBOX_REPORT && report.length) writeFileSync(process.env.INBOX_REPORT, report.join("\n") + "\n");
  console.log(`\nCheck each draft against the post and its pictures, fill in the TODOs (the change in fr/ar/en, anything else the text can't give), then: node scripts/inbox.mjs --approve <draft>`);
}

/** An export of the page's posts: one draft per post the claims don't cite yet. */
function readExport(f, known) {
  const posts = JSON.parse(readFileSync(join(INBOX, f), "utf8"));
  if (!Array.isArray(posts)) return console.log(`${f}: not a list of posts, skipped`);
  const { claims, ignored = [] } = JSON.parse(readFileSync(`${DIR}/claims.json`, "utf8"));
  // Facebook gives a post a different link on each visit; its time (to the second) stays the same.
  const cited = new Set([...claims.flatMap((c) => [c.source.url, c.source.posted]), ...ignored.flatMap((i) => [i.url, i.posted])].filter(Boolean));
  let fresh = 0;
  for (const p of posts) {
    const url = String(p.url ?? "").split("?")[0];
    const date = String(p.time ?? "").slice(0, 10);
    // A post can be only a picture (a route map): it still gets a draft, to look at.
    if ((!p.text && !p.media?.length) || !url || cited.has(url) || cited.has(p.time)) continue;
    p.text ??= "";
    const found = extract(p.text, known, p.page ?? "ALSA Facebook");
    // The post itself gives the link and the day; what it says still needs a person.
    for (const c of found.claims) c.source = { ...c.source, url, posted: p.time, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : c.source.date };
    // Fare grids and maps are pictures: their links go with the draft, to look at.
    const pictures = (p.media ?? []).map((m) => m.photo_image?.uri ?? m.thumbnail).filter(Boolean);
    const id = (url.split("/").filter(Boolean).pop() ?? "post").slice(0, 24);
    const out = join(DRAFTS, `${date}-${id}.json`);
    writeFileSync(out, JSON.stringify({ file: f, post: url, posted: p.time, ...found, pictures, text: p.text }, null, 2) + "\n");
    console.log(`${date}: lines ${found.lines.join(", ") || "none"} · ${found.kinds.join(", ") || "no change words"} · ${pictures.length} picture(s) · ${found.claims.length} draft claim(s) → ${out}`);
    report.push(`- ${date} · ${p.page ?? "ALSA Facebook"} · [post](${url}) · lines ${found.lines.join(", ") || "none named"} · ${found.kinds.join(", ") || "no change words"} · ${pictures.length} picture(s)\n  > ${p.text.replace(/\s+/g, " ").slice(0, 240) || "(a picture, no text)"}`);
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
  if (!draft.post) throw new Error("only posts from an export can be set aside; delete a .txt draft instead");
  const file = `${DIR}/claims.json`;
  const all = JSON.parse(readFileSync(file, "utf8"));
  all.ignored = [...(all.ignored ?? []), { url: draft.post, ...(draft.posted ? { posted: draft.posted } : {}), date: draft.claims[0]?.source.date ?? basename(path).slice(0, 10), why }];
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  renameSync(path, join(EVIDENCE, basename(path)));
  console.log(`set aside: ${draft.post}`);
}
