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
      const version = hash.digest("hex").slice(0, 12);
      const sizes = list.map((f) => statSync(join(outDir, f)).size);
      writeFileSync(join(outDir, "precache.json"), JSON.stringify({ version, files: list.map((f) => (f === "index.html" ? "./" : f)).concat("index.html"), sizes: sizes.concat(sizes[list.indexOf("index.html")] ?? 0) }));
      const sw = join(outDir, "sw.js");
      writeFileSync(sw, readFileSync(sw, "utf8").replace("__VERSION__", version));
      const total = sizes.reduce((a, b) => a + b, 0);
      console.log(`precache: ${list.length} files, ${(total / 1048576).toFixed(1)} MiB, version ${version}`);
    },
  };
}

export default defineConfig({
  base: "./",
  build: { target: "es2022", assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  plugins: [precache()],
});
