// Takes the README's phone screenshots from a built Tobis, in a real Chrome over its
// debugging port: a fresh profile, French, the clock at 10:00, the GPS in Talborjt.
//   node scripts/screenshots.mjs [site] [--cdp=http://127.0.0.1:9222]   (writes docs/screenshots/*.png)
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const SITE = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:4173/";
const CDP = args.find((a) => a.startsWith("--cdp="))?.slice(6) ?? "http://127.0.0.1:9222";
// --at=01:28 pins the page clock to another time; --out=dir writes elsewhere (for reviews).
const AT = args.find((a) => a.startsWith("--at="))?.slice(5) ?? "10:00";
const OUT_ARG = args.find((a) => a.startsWith("--out="))?.slice(6);
const OUT = OUT_ARG ? new URL(`file://${OUT_ARG.replace(/\/?$/, "/")}`) : new URL("../docs/screenshots/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const TALBORJT = [-9.5981, 30.4202];
const TRIP = "#from=-9.5981,30.4202,Talborjt&to=-9.53,30.395,Dcheira";

const version = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
  else p.resolve(m.result);
};
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { browserContextId } = await send("Target.createBrowserContext", { disposeOnDetach: true });
const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, s);
await send("Runtime.enable", {}, s);
await send("Browser.grantPermissions", { origin: new URL(SITE).origin, browserContextId, permissions: ["geolocation"] });
const where = (lng, lat) => send("Emulation.setGeolocationOverride", { latitude: lat, longitude: lng, accuracy: 10 }, s);
await where(...TALBORJT);
await send(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `(() => {
      const R = Date, d = new R(), shift = new R(d.getFullYear(), d.getMonth(), d.getDate(), ${Number(AT.split(":")[0])}, ${Number(AT.split(":")[1])}).getTime() - R.now();
      class F extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + shift); } static now() { return R.now() + shift; } }
      globalThis.Date = F;
    })();`,
  },
  s,
);
const phone = async (scheme) => {
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true }, s);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, s);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] }, s);
};
async function run(fn, ...a) {
  const r = await send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true, userGesture: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function until(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await run(fn).catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
async function open(url) {
  await run(() => ((window.__old = true), true)).catch(() => {});
  await send("Page.navigate", { url }, s);
  await until("the app", () => !window.__old && document.readyState === "complete" && document.querySelector(".sheet-body > *"));
}
// Map tiles drawn, timed messages gone, the credit folded to its (i): what someone sees after a moment.
async function settle() {
  await until("the map", () => document.querySelector(".maplibregl-canvas")?.width > 0);
  await sleep(2500);
  await run(() => {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    document.querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");
    document.getAnimations().forEach((a) => a.finish());
    return true;
  });
  await sleep(300);
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, s);
  writeFileSync(new URL(`${name}.png`, OUT), Buffer.from(data, "base64"));
  console.log(new URL(`${name}.png`, OUT).pathname);
}

await phone("light");
await open(SITE);
await run(() => (localStorage.setItem("lang", "fr"), true));
await open(SITE);
await settle();
await shot("home");

await open(SITE + "?r" + TRIP);
await until("trips", () => document.querySelector(".option"));
await settle();
await shot("results");

await run(() => ([...document.querySelectorAll(".option")].find((o) => /Trambus/.test(o.textContent)).click(), true));
await until("the trip", () => document.querySelector(".tl-stop"));
await settle();
await shot("trip");

// Ride mode, a few stops into the Trambus ride.
const leg = await run(() => ({ board: document.querySelector(".tl-stop .tl-stop-name").textContent.trim(), alight: document.querySelector(".tl-off .tl-stop-name").textContent.trim() }));
const net = await (await fetch(new URL("data/agadir.json", SITE))).json();
const brt = net.lines.find((l) => l.brt);
const v = brt.variants.find((v) => v.stops.some((i) => net.stops[i].n.d === leg.board));
const names = v.stops.map((i) => net.stops[i].n.d);
const a = names.indexOf(leg.board);
const path = v.stops.slice(a, names.indexOf(leg.alight, a) + 1).map((i) => net.stops[i].ll);
await run(() => (document.querySelector(".trip-start .btn-primary").click(), true));
await until("ride mode", () => document.querySelector(".ride"));
for (const ll of path.slice(0, 6)) {
  await where(...ll);
  await sleep(500);
}
await until("stops left", () => document.querySelector(".ride-big .num"));
await settle();
await shot("ride");
await where(...TALBORJT);

// A Trambus stop and its next passages.
await open(SITE + "?s");
await run(() => ([...document.querySelectorAll(".sheet-body .row")].find((r) => /Port/.test(r.textContent)).click(), true));
await until("the Trambus line", () => document.querySelector(".line .row"));
await run(() => (document.querySelectorAll(".line .row")[6].click(), true));
await until("the stop", () => document.querySelector(".stop-passes"));
await settle();
await shot("stop");

// Darija, dark.
await phone("dark");
await run(() => (localStorage.setItem("lang", "ar"), true));
await open(SITE + "?ar" + TRIP);
await until("trips", () => document.querySelector(".option"));
await settle();
await shot("darija-dark");
await run(() => (localStorage.setItem("lang", "fr"), true));

await send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
ws.close();
