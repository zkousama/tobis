// Packs the built data the site needs but git doesn't hold (public/data/ and the
// offline map) into one archive, and records which archive a deploy should use in
// data.lock.json. The archive goes up as a GitHub release asset; the deploy
// workflow downloads it, checks its fingerprint and builds with it.
//
//   node scripts/pack-data.mjs            pack, and point data.lock.json at it
//   node scripts/pack-data.mjs --unpack   extract the archive named in data.lock.json (already downloaded to data-pack/)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const FILES = ["public/data/agadir.json", "public/data/agadir-walk.bin", "public/basemap/agadir.pmtiles"];
const DIR = "data-pack";
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

if (process.argv.includes("--unpack")) {
  const lock = JSON.parse(readFileSync("data.lock.json", "utf8"));
  const file = `${DIR}/${lock.file}`;
  if (!existsSync(file)) throw new Error(`${file} missing: download release ${lock.tag} first`);
  const got = sha256(file);
  if (got !== lock.sha256) throw new Error(`${file}: fingerprint ${got} doesn't match data.lock.json (${lock.sha256})`);
  execFileSync("tar", ["-xzf", file]);
  for (const f of FILES) if (!existsSync(f)) throw new Error(`${f} not in the archive`);
  console.log(`unpacked ${lock.file} (${lock.tag})`);
} else {
  for (const f of FILES) if (!existsSync(f)) throw new Error(`${f} missing: build the data first`);
  const net = JSON.parse(readFileSync("public/data/agadir.json", "utf8"));
  // Named after the data, not the day it's packed: the OpenStreetMap snapshot and the ALSA fetch.
  const day = (s) => (s ? String(s).slice(0, 10) : "unknown");
  // A rebuild from the same sources can still differ (a config change), so the tag ends with a content fingerprint.
  const files = Object.fromEntries(FILES.map((f) => [f, sha256(f)]));
  const content = createHash("sha256").update(Object.values(files).join("")).digest("hex").slice(0, 8);
  const tag = `data-${day(net.osmTimestamp)}-alsa-${day(net.alsaFetched)}-${content}`;
  const file = `tobis-${tag}.tar.gz`;
  const tar = `${DIR}/${file.replace(/\.gz$/, "")}`;
  mkdirSync(DIR, { recursive: true });
  // Fixed owner and time, so the same data packs to the same bytes.
  execFileSync("tar", ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=2000-01-01", "-cf", tar, ...FILES]);
  execFileSync("gzip", ["-nf9", tar]);
  const lock = { tag, file, sha256: sha256(`${DIR}/${file}`), files };
  writeFileSync("data.lock.json", JSON.stringify(lock, null, 2) + "\n");
  console.log(`${DIR}/${file}: ${(statSync(`${DIR}/${file}`).size / 1048576).toFixed(1)} MiB, tag ${tag}`);
  console.log(`publish it with: gh release create ${tag} ${DIR}/${file} --title "${tag}" --notes "Built data for the deploy."`);
}
