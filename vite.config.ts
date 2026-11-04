import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// After the build: list every output file for the service worker to cache,
// and stamp the worker with a hash of the contents so updates replace the cache.
function precache(): Plugin {
  let outDir = "dist";
  return {
    name: "precache",
    apply: "build",
    configResolved(c) {
      outDir = join(c.root, c.build.outDir);
    },
    closeBundle() {
      if (!existsSync(join(outDir, "index.html"))) return; // the build failed; let its error show
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split("\\").join("/"));
        }
      };
      walk(outDir);
      const skip = /^(sw\.js|precache\.json|_headers|_redirects|.*\.map|basemap\/fonts\/OFL\.txt)$/;
      const list = files.filter((f) => !skip.test(f)).sort();
      const hash = createHash("sha256");
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      hash.update(readFileSync(join(outDir, "sw.js"))); // a fix to the worker alone is a new version too
      // The saved page keeps the headers it was served with, so a header change is a new version too.
      if (existsSync(join(outDir, "_headers"))) hash.update(readFileSync(join(outDir, "_headers")));
      const version = hash.digest("hex").slice(0, 12);
      const sizes = list.map((f) => statSync(join(outDir, f)).size);
      // Per-file fingerprints let an update keep the files that didn't change.
      const hashes = list.map((f) => createHash("sha256").update(readFileSync(join(outDir, f))).digest("hex").slice(0, 16));
      // The page is cached as "./" only: hosts like Cloudflare Pages redirect
      // /index.html to /, and a redirected response can't answer a page load.
      writeFileSync(join(outDir, "precache.json"), JSON.stringify({ version, files: list.map((f) => (f === "index.html" ? "./" : f)), sizes, hashes }));
      const sw = join(outDir, "sw.js");
      const src = readFileSync(sw, "utf8");
      if (!src.includes('const VERSION = "__VERSION__";')) throw new Error("sw.js: VERSION placeholder not found");
      writeFileSync(sw, src.replace('const VERSION = "__VERSION__";', `const VERSION = "${version}";`));
      const total = sizes.reduce((a, b) => a + b, 0);
      // Everyone downloads all of this: a change that grows it past the budget fails the build.
      const BUDGET_MIB = 30;
      if (total / 1048576 > BUDGET_MIB) throw new Error(`offline copy is ${(total / 1048576).toFixed(1)} MiB, over the ${BUDGET_MIB} MiB budget`);
      console.log(`precache: ${list.length} files, ${(total / 1048576).toFixed(1)} MiB, version ${version}`);
    },
  };
}

export default defineConfig({
  base: "./",
  build: { target: "es2022", assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  plugins: [precache()],
});
