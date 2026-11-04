// Drives a real Chrome through the main screens of a built Tobis and fails on
// any page error. Talks to Chrome over its debugging port, in a fresh profile
// each run (no cache, no storage, no service worker from before).
//
//   node scripts/smoke.mjs [site] [--cdp=http://127.0.0.1:9222] [--styles=out.json]
//
// --styles also records the computed style and box of every element in the
// sheet and the map buttons on each screen: two such files from builds that
// should look the same can be compared with scripts/style-diff.mjs.
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SITE = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:4173/";
const CDP = opt("cdp", "http://127.0.0.1:9222");
const STYLES = opt("styles");

// ---------- a minimal debugging-protocol client ----------
const version = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const listeners = [];
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
    else p.resolve(m.result);
  } else if (m.method) for (const l of listeners) l(m);
};
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));

const { browserContextId } = await send("Target.createBrowserContext", { disposeOnDetach: true });
const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
const problems = [];
listeners.push((m) => {
  if (m.sessionId !== s) return;
  if (m.method === "Runtime.exceptionThrown") problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "")) problems.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
});
for (const d of ["Page", "Runtime", "Log", "Network"]) await send(`${d}.enable`, {}, s);
const phone = async (scheme = "light") => {
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true }, s);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, s); // focus events fire in a background tab too
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] }, s);
};
await phone();

/** Runs `fn` (a function's source) in the page and returns its result. */
async function run(fn, ...a) {
  const r = await send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20000, ...a) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await run(fn, ...a).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
async function open(url) {
  // Mark the current document, so the wait below can't be answered by it.
  await run(() => ((window.__smokeOld = true), true)).catch(() => {});
  await send("Page.navigate", { url }, s);
  await until("the planner", () => !window.__smokeOld && document.querySelector(".sheet-body .planner, .sheet-body .view-head") && document.readyState === "complete");
  await run(() => document.fonts.ready.then(() => true));
}

// ---------- the walk through ----------
const results = [];
const styles = {};
let failed = false;
async function step(name, fn) {
  const before = problems.length;
  try {
    await fn();
    if (problems.length > before) throw new Error(problems.slice(before).join("\n      "));
    results.push(`ok    ${name}`);
  } catch (err) {
    failed = true;
    results.push(`FAIL  ${name}\n      ${String(err.message ?? err).split("\n").join("\n      ")}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// The sheet and the map buttons, element by element: what a style change would move.
const snapshot = () => {
  const PROPS = ["display", "position", "width", "height", "margin", "padding", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity", "gap", "flex", "grid-template-columns", "align-items", "justify-content", "text-align", "white-space", "overflow", "z-index", "transform", "visibility", "text-overflow", "inset-inline-start", "inset-inline-end", "top", "bottom", "outline", "text-decoration", "cursor"];
  const out = {};
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.id !== "app"; e = e.parentElement) {
      const i = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0;
      parts.unshift(`${e.tagName.toLowerCase()}${e.classList.length ? "." + [...e.classList].sort().join(".") : ""}:${i}`);
    }
    return parts.join(">");
  };
  for (const root of document.querySelectorAll("#app > .sheet, #app > .topbar, #app > .fab")) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const v = { box: [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(",") };
      for (const p of PROPS) v[p] = cs.getPropertyValue(p);
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content && ps.content !== "none") v[pseudo] = PROPS.map((p) => ps.getPropertyValue(p)).join("|") + "|" + ps.content;
      }
      out[path(el)] = v;
    }
  }
  return out;
};
const shot = async (name) => {
  if (!STYLES) return;
  await run(() => {
    document.getAnimations().forEach((a) => a.finish());
    document.querySelectorAll(".toast").forEach((t) => t.remove()); // timed messages come and go
    const b = document.querySelector(".sheet-body");
    if (b) b.scrollTop = 0;
    return true;
  });
  await sleep(150);
  styles[name] = await run(snapshot);
};

const TRIP = "#from=-9.59810,30.42020,Talborjt&to=-9.53000,30.39500,Dcheira";

await step("home opens, with the map", async () => {
  // A fresh profile follows the browser's language: pin French, the default the checks read.
  await open(SITE);
  await run(() => (localStorage.setItem("lang", "fr"), true));
  await open(SITE);
  await until("the map canvas", () => document.querySelector(".maplibregl-canvas")?.width > 0);
  const t = await run(() => [...document.querySelectorAll(".sheet-body input")].map((i) => i.placeholder).join(" "));
  ok(/Où allez-vous/.test(t), "no 'Où allez-vous' field on home");
  await shot("home");
});

await step("the first visit doesn't reload by itself when the offline copy is saved", async () => {
  await run(() => ((window.__firstVisit = true), true));
  await until("the offline copy", async () => {
    const list = await (await fetch("precache.json")).json();
    const k = await caches.keys();
    return k.length === 1 && (await (await caches.open(k[0])).keys()).length >= list.files.length + 1 && navigator.serviceWorker.controller;
  }, 120000);
  await sleep(1500);
  ok(await run(() => window.__firstVisit === true), "the page reloaded");
});

await step("search finds a place by a misspelt name", async () => {
  await run(() => (document.querySelector(".sheet-body input")?.focus(), true));
  await until("the search screen", () => document.querySelector(".sheet.view-search .sheet-body input"));
  await run(() => {
    const i = document.querySelector(".sheet-body input");
    i.value = "farmacie";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  const n = await until("search results", () => document.querySelectorAll(".sheet-body li .row").length).catch(async (e) => {
    throw new Error(`${e.message}; screen: ${await run(() => document.querySelector(".sheet").className + " | " + document.querySelector(".sheet-body").innerText.slice(0, 160))}`);
  });
  ok(n > 0, "no results for 'farmacie'");
  await shot("search");
});

await step("a trip: options compared, the Trambus with its card", async () => {
  await open(SITE + "?trip" + TRIP);
  const n = await until("trip options", () => document.querySelectorAll(".option").length);
  ok(n >= 2, `only ${n} option(s)`);
  const card = await run(() => document.querySelector(".ticket-card")?.innerText ?? "");
  ok(/carte/.test(card), "no card cost on the Trambus option");
  await shot("results");
  await run(() => (document.querySelector(".pref-open")?.click(), true));
  await shot("results-prefs");
});

await step("trip view: steps, the card note, back to the list", async () => {
  await run(() => (document.querySelector(".option")?.click(), true));
  await until("the trip steps", () => document.querySelector(".tl-stop"));
  ok(await run(() => !!document.querySelector(".card-note")), "no card note in the trip");
  await shot("trip");
  await run(() => (history.back(), true));
  await until("the options again", () => document.querySelector(".option"));
});

await step("settings: language, appearance, Trambus, version", async () => {
  await run(() => (document.querySelector(".map-btn")?.click(), true));
  await until("settings", () => document.querySelector(".setting-list"));
  const t = await run(() => document.querySelector(".sheet-body").innerText);
  ok(/Langue/.test(t) && /Apparence/.test(t) && /Trambus/.test(t), "a settings section is missing");
  await shot("settings");
});

await step("leaving the Trambus out removes it from the options", async () => {
  await run(() => ([...document.querySelectorAll(".setting-list button")].find((b) => /proposer/.test(b.innerText))?.click(), true));
  await open(SITE + "?skip" + TRIP);
  await until("trip options", () => document.querySelector(".option"));
  const brt = await run(() => [...document.querySelectorAll(".option")].some((o) => /Trambus/.test(o.innerText)));
  ok(!brt, "a Trambus option is still shown");
  ok(await run(() => !!document.querySelector(".brt-off")), "no 'Trambus left out' line");
  await run(() => (localStorage.removeItem("skipBrt"), true));
});

await step("help opens", async () => {
  await open(SITE + "?help");
  await run(() => ([...document.querySelectorAll(".sheet-body button, .sheet-body a")].find((b) => /Comment ça marche/.test(b.innerText))?.click(), true));
  await until("help", () => document.querySelector(".help"));
  await shot("help");
});

await step("Darija, right to left, dark", async () => {
  await phone("dark");
  await run(() => (localStorage.setItem("lang", "ar"), true));
  await open(SITE + "?ar" + TRIP);
  await until("trip options", () => document.querySelector(".option"));
  ok((await run(() => document.documentElement.dir)) === "rtl", "page isn't right to left");
  await shot("results-ar-dark");
  await run(() => (localStorage.setItem("lang", "fr"), true));
  await phone("light");
});

await step("200 % text: nothing runs off the side", async () => {
  await open(SITE + "?big" + TRIP);
  await until("trip options", () => document.querySelector(".option"));
  const wide = await run(() => {
    document.documentElement.style.fontSize = "200%";
    const b = document.querySelector(".sheet-body");
    return b.scrollWidth - b.clientWidth;
  });
  ok(wide <= 1, `the sheet scrolls sideways by ${wide}px`);
});

await step("works offline once saved", async () => {
  await open(SITE);
  await until("the offline copy", async () => {
    const list = await (await fetch("precache.json")).json();
    const k = await caches.keys();
    return k.length === 1 && (await (await caches.open(k[0])).keys()).length >= list.files.length + 1;
  }, 120000);
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);
  // The planner, the data and the map must all come from the phone.
  problems.length = 0;
  await open(SITE + "?offline" + TRIP);
  await until("trip options offline", () => document.querySelector(".option"));
  await until("the map offline", () => document.querySelector(".maplibregl-canvas")?.width > 0);
  ok(await run(() => !document.querySelector(".offline-banner").hidden), "no offline banner");
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);
});

await send("Target.closeTarget", { targetId }).catch(() => {});
await send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
ws.close();
if (STYLES) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(STYLES, JSON.stringify(styles));
}
console.log(results.join("\n"));
console.log(failed ? "\nsmoke: FAILED" : "\nsmoke: all passed");
process.exit(failed ? 1 : 0);
