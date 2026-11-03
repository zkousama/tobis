// Offline cache. The build replaces __VERSION__ and writes precache.json.
const VERSION = "__VERSION__";
const CACHE = `agadir-bus-${VERSION}`;
const channel = new BroadcastChannel("offline");
let progress = { done: 0, total: 1 };

const scopeUrl = (p) => new URL(p, self.registration.scope).href;

async function precache() {
  const list = await (await fetch(scopeUrl(`precache.json?v=${VERSION}`), { cache: "no-store" })).json();
  const cache = await caches.open(CACHE);
  await cache.put(scopeUrl("precache.json"), new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } }));
  const urls = list.files.map((f) => scopeUrl(f));
  progress = { done: 0, total: urls.length };
  // Small files first so the app is usable while the map downloads.
  const sized = urls.map((u, i) => ({ u, size: list.sizes[i] })).sort((a, b) => a.size - b.size);
  let next = 0;
  const worker = async () => {
    while (next < sized.length) {
      const { u } = sized[next++];
      if (!(await cache.match(u))) {
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await fetch(u, { cache: "no-cache" });
            if (!res.ok) throw new Error(`${res.status}`);
            await cache.put(u, res);
            break;
          } catch (err) {
            if (attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          }
        }
      }
      progress.done++;
      channel.postMessage({ type: "progress", ...progress });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

self.addEventListener("install", (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("agadir-bus-") && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
      channel.postMessage({ type: "progress", ...progress, done: progress.total });
    })(),
  );
});

self.addEventListener("message", async (e) => {
  if (e.data?.type !== "status") return;
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  const list = await (await cache.match(scopeUrl("precache.json")))?.json().catch(() => null);
  const total = list?.files?.length ?? keys.length;
  channel.postMessage({ type: "progress", done: Math.min(keys.length, total), total });
});

// Serve a byte range out of a cached full response (the map file is read in pieces).
async function rangeResponse(req, res) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get("range") || "");
  const blob = await res.blob();
  if (!m) return new Response(blob, { status: 200, headers: res.headers });
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "content-type": res.headers.get("content-type") || "application/octet-stream",
      "content-range": `bytes ${start}-${end}/${blob.size}`,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = url.origin + url.pathname;
      if (req.mode === "navigate") {
        // App shell first: opens instantly with no signal. Updates arrive with a new worker.
        const shell = (await cache.match(scopeUrl("index.html"))) || (await cache.match(scopeUrl("./")));
        if (shell) return shell;
        return fetch(req);
      }
      const hit = await cache.match(key, { ignoreSearch: true });
      if (hit) return req.headers.has("range") ? rangeResponse(req, hit) : hit;
      const res = await fetch(req);
      return res;
    })(),
  );
});
