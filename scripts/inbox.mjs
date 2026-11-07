// The council's inbox: screenshots of operator posts (or their text, pasted into a .txt) go in
// data/council/inbox/. This reads each one (OCR for images, in French, Arabic and English), drafts the
// claims it seems to make, and waits for a person to check them.
//
//   node scripts/inbox.mjs                       read the inbox, write a draft per file in data/council/drafts/
//   node scripts/inbox.mjs --approve <draft>     after filling in the TODOs: add its claims to claims.json
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
else await read();

async function read() {
  const files = readdirSync(INBOX).filter((f) => /\.(png|jpe?g|webp|txt)$/i.test(f));
  if (!files.length) return console.log(`Nothing in ${INBOX}/. Put screenshots of operator posts there (or their text in a .txt).`);
  const net = JSON.parse(readFileSync("public/data/agadir.json", "utf8"));
  const known = { lines: net.lines.map((l) => l.ref), stops: net.stops.map((s) => s.n.d).filter(Boolean) };
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
  if (existsSync(join(INBOX, draft.file))) renameSync(join(INBOX, draft.file), join(EVIDENCE, draft.file));
  renameSync(path, join(EVIDENCE, basename(path)));
  console.log(`${draft.claims.length} claim(s) added to ${file}; the picture and draft are kept in ${EVIDENCE}/. Rebuild the data to let the council weigh them.`);
}
