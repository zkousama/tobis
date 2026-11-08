// Drives a real Chrome through every scenario of a built Tobis, as a phone and
// as a desktop browser, and fails on any page error. Talks to Chrome over its
// debugging port, in a fresh profile per run (no cache, storage or service
// worker from before). The page's clock is pinned to 10:00, so results don't
// depend on when the check runs (the Trambus starts at 6:00).
//
//   node scripts/smoke.mjs [site] [--cdp=http://127.0.0.1:9222] [--only=phone|desktop] [--styles=out.json]
//
// --styles records the computed style and box of every element in the sheet and
// the map buttons on the phone's main screens; scripts/style-diff.mjs compares two.
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SITE = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:4173/";
const CDP = opt("cdp", "http://127.0.0.1:9222");
const STYLES = opt("styles");
const ONLY = opt("only");

// The accessibility checker (axe, WCAG 2.2 AA rules plus best practices), put into the page on demand.
const { readFileSync } = await import("node:fs");
const AXE = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const notes = []; // moderate and minor accessibility findings: listed, not failed

const PROFILES = [
  { name: "phone", width: 393, height: 852, mobile: true, touch: true },
  { name: "desktop", width: 1366, height: 768, mobile: false, touch: false },
].filter((p) => !ONLY || p.name === ONLY);

// Places used by the scenarios (lng, lat).
const TALBORJT = [-9.5981, 30.4202];
const DCHEIRA = [-9.53, 30.395];
const TRIP = `#from=${TALBORJT.join(",")},Talborjt&to=${DCHEIRA.join(",")},Dcheira`;

// ---------- a minimal debugging-protocol client ----------
// Chrome may still be starting (on a busy runner): keep asking for 30 s before giving up.
async function chromeVersion() {
  for (let i = 0; ; i++) {
    try {
      return await (await fetch(`${CDP}/json/version`)).json();
    } catch (err) {
      if (i >= 30) throw new Error(`no Chrome on ${CDP} after 30 s (${err.cause?.code ?? err.message})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
const version = await chromeVersion();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const styles = {};
let failed = false;

for (const P of PROFILES) await runProfile(P);

ws.close();
if (STYLES) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(STYLES, JSON.stringify(styles));
}
console.log(results.join("\n"));
if (notes.length) console.log(`\naccessibility notes (moderate or minor, not failures):\n  ${[...new Set(notes)].join("\n  ")}`);
console.log(failed ? "\nsmoke: FAILED" : "\nsmoke: all passed");
process.exit(failed ? 1 : 0);

async function runProfile(P) {
  const { browserContextId } = await send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  const problems = [];
  const onEvent = (m) => {
    if (m.sessionId !== s) return;
    if (m.method === "Runtime.exceptionThrown") problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon|api\/expand/.test(m.params.entry.url ?? "")) problems.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  };
  listeners.push(onEvent);
  for (const d of ["Page", "Runtime", "Log", "Network"]) await send(`${d}.enable`, {}, s);
  await send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `(() => {
        const R = Date, d = new R(), shift = new R(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0).getTime() - R.now();
        class F extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + shift); } static now() { return R.now() + shift; } }
        globalThis.Date = F;
      })();`,
    },
    s,
  );
  const origin = new URL(SITE).origin;
  await send("Browser.grantPermissions", { origin, browserContextId, permissions: ["geolocation"] });
  const where = (lng, lat, accuracy = 10) => send("Emulation.setGeolocationOverride", { latitude: lat, longitude: lng, accuracy }, s);
  await where(...TALBORJT);
  const look = async (scheme = "light") => {
    await send("Emulation.setDeviceMetricsOverride", { width: P.width, height: P.height, deviceScaleFactor: P.mobile ? 2 : 1, mobile: P.mobile }, s);
    await send("Emulation.setTouchEmulationEnabled", P.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, s);
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }, s); // focus events fire in a background tab too
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] }, s);
  };
  await look();

  /** Runs `fn` (a function's source) in the page and returns its result. */
  async function run(fn, ...a) {
    const r = await send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true, userGesture: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
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
    await until("the app", () => !window.__smokeOld && document.querySelector(".sheet-body .planner, .sheet-body .view-head, .sheet-body .empty-state") && document.readyState === "complete");
    await run(() => document.fonts.ready.then(() => true));
  }
  const key = (k, code = k) => send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: k === "Enter" ? 13 : k === "Escape" ? 27 : 0 }, s).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code }, s));
  const click = (sel, text) => run((sel, text) => {
    // Only what's on screen: a hidden element can carry the same text.
    const el = [...document.querySelectorAll(sel)].find((e) => (!text || e.textContent.includes(text)) && e.getClientRects().length > 0);
    if (!el) throw new Error(`nothing to click: ${sel}${text ? ` "${text}"` : ""}`);
    el.click();
    return true;
  }, sel, text);
  const text = (sel) => run((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.trim()).join(" | "), sel);
  const ok = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  async function step(name, fn) {
    const before = problems.length;
    try {
      await fn();
      if (problems.length > before) throw new Error(problems.slice(before).join("\n      "));
      results.push(`ok    ${P.name.padEnd(7)} ${name}`);
    } catch (err) {
      failed = true;
      results.push(`FAIL  ${P.name.padEnd(7)} ${name}\n      ${String(err.message ?? err).split("\n").join("\n      ")}`);
    }
  }
  const noSideways = async (where) => {
    const r = await run(() => ({ page: document.documentElement.scrollWidth - innerWidth, sheet: (() => { const b = document.querySelector(".sheet-body"); return b ? b.scrollWidth - b.clientWidth : 0; })() }));
    ok(r.page <= 1 && r.sheet <= 1, `${where}: scrolls sideways (page ${r.page}px, sheet ${r.sheet}px)`);
  };
  const shot = async (name) => {
    if (!STYLES || P.name !== "phone") return;
    await run(() => {
      document.getAnimations().forEach((a) => a.finish());
      document.querySelectorAll(".toast").forEach((t) => t.remove());
      const b = document.querySelector(".sheet-body");
      if (b) b.scrollTop = 0;
      return true;
    });
    await sleep(150);
    styles[name] = await run(snapshot);
  };
  /** Accessibility check of what's on screen now: serious or critical problems fail the step. */
  const audit = async (screen) => {
    await send("Runtime.evaluate", { expression: `window.axe ? true : ((() => { ${AXE}\n })(), true)`, returnByValue: true }, s);
    const found = await run(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
        // The map's canvas is a picture of the streets; its controls and labels are still checked.
        exclude: [[".maplibregl-canvas-container"]],
        resultTypes: ["violations"],
      });
      // Each failing element, with what axe says it collides with (named in the log if it fails on GitHub).
      const near = (n) => [...(n.any ?? []), ...(n.none ?? [])].flatMap((c) => (c.relatedNodes ?? []).map((x) => x.target.join(" "))).slice(0, 3);
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, where: v.nodes.slice(0, 3).map((n) => n.target.join(" ") + (near(n).length ? ` (next to: ${near(n).join(", ")})` : "")) }));
    });
    const bad = found.filter((v) => v.impact === "serious" || v.impact === "critical");
    for (const v of found.filter((v) => !bad.includes(v))) notes.push(`${P.name} ${screen}: ${v.impact} ${v.id} (${v.help}) at ${v.where.join(", ")}`);
    ok(!bad.length, `accessibility, ${screen}:\n${bad.map((v) => `${v.impact} ${v.id}: ${v.help}\n  at ${v.where.join("\n  at ")}`).join("\n")}`);
  };
  const setLang = (l) => run((l) => (localStorage.setItem("lang", l), true), l);
  const clearPrefs = () => run(() => (["skipBrt", "skipBus", "avoidLines", "card:BHNS", "avoidWalk", "route", "vot"].forEach((k) => localStorage.removeItem(k)), true));
  const tripOptions = () => until("trip options", () => document.querySelectorAll(".option").length);
  const optionLines = () => run(() => [...document.querySelectorAll(".option")].map((o) => [...o.querySelectorAll(".badge")].map((b) => b.textContent.trim())));

  // ---------- the scenarios ----------
  await step("home: map, rows, no sideways scroll", async () => {
    // A fresh profile follows the browser's language: pin French, the default the checks read.
    await open(SITE);
    await setLang("fr");
    await open(SITE);
    await until("the map canvas", () => document.querySelector(".maplibregl-canvas")?.width > 0);
    const ph = await run(() => [...document.querySelectorAll(".sheet-body input")].map((i) => i.placeholder).join(" "));
    ok(/Où allez-vous/.test(ph), "no 'Où allez-vous' field");
    const t = await text(".sheet-body");
    ok(/Lignes/.test(t) && /Toutes les lignes/.test(t) && /Comment ça marche/.test(t), "a home row is missing");
    await noSideways("home");
    if (P.name === "desktop") {
      const r = await run(() => document.querySelector(".sheet").getBoundingClientRect().toJSON());
      ok(r.width < 520 && r.height > 600, `the panel isn't a side panel on desktop (${Math.round(r.width)}×${Math.round(r.height)})`);
    }
    await shot("home");
    await audit("home");
  });

  await step("first visit doesn't reload by itself when the offline copy is saved", async () => {
    await run(() => ((window.__firstVisit = true), true));
    await until("the offline copy", async () => {
      const list = await (await fetch("precache.json")).json();
      const k = await caches.keys();
      return k.length === 1 && (await (await caches.open(k[0])).keys()).length >= list.files.length + 1 && navigator.serviceWorker.controller;
    }, 120000);
    await sleep(1500);
    ok(await run(() => window.__firstVisit === true), "the page reloaded");
  });

  await step("empty-field hints don't look like typed text", async () => {
    const r = await run(() => {
      const i = document.querySelector(".sheet-body input");
      const ph = getComputedStyle(i, "::placeholder");
      const v = getComputedStyle(i);
      return { phColor: ph.color, phWeight: ph.fontWeight, color: v.color, weight: v.fontWeight };
    });
    ok(r.phColor !== r.color, `hint colour ${r.phColor} = text colour`);
    ok(Number(r.phWeight) < Number(r.weight), `hint weight ${r.phWeight} not lighter than text ${r.weight}`);
  });

  await step("my location: 'Partir d'où je suis' uses the GPS", async () => {
    // The row only shows while location hasn't been allowed; this profile allows it, so it may already be gone.
    const shown = await run(() => [...document.querySelectorAll(".sheet-body .row")].some((r) => /Partir d'où je suis/.test(r.textContent)));
    if (shown) await click(".sheet-body .row", "Partir d'où je suis");
    await until("the location row to go", () => ![...document.querySelectorAll(".sheet-body .row")].some((r) => /Partir d'où je suis/.test(r.textContent)));
    await until("my position on the map", () => document.querySelector(".me-dot, .maplibregl-marker.me, .me"), 10000).catch(() => {
      throw new Error("no position marker on the map");
    });
  });

  const typeSearch = async (q) => {
    await run((q) => {
      const i = document.querySelector(".sheet.view-search .sheet-body input");
      i.value = q;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, q);
  };
  const openSearch = async () => {
    await run(() => (document.querySelector(".sheet-body input")?.focus(), true));
    await until("the search screen", () => document.querySelector(".sheet.view-search .sheet-body input"));
  };

  await step("search: misspelt, Arabic, a line number", async () => {
    await openSearch();
    for (const [q, want] of [["farmacie", /pharmacie/i], ["talbrojt", /talborjt/i], ["انزكان", /inezgane/i]]) {
      await typeSearch(q);
      // Wait for this query's results, not the previous one's still on screen.
      await until(`'${q}' to find ${want}`, (src) => new RegExp(src, "i").test(document.querySelector(".results-list")?.textContent ?? ""), 8000, want.source);
    }
    await typeSearch("32");
    await until("line 32", () => [...document.querySelectorAll(".results-list .badge")].some((b) => b.textContent.trim() === "32"));
    await shot("search");
    await audit("search");
  });

  await step("search: Enter picks the first place and plans from my location", async () => {
    await typeSearch("dcheira");
    await until("results for dcheira", () => /dche[iï]ra/i.test(document.querySelector(".results-list .row")?.textContent ?? ""));
    await run(() => (document.querySelector(".sheet.view-search .sheet-body input").focus(), true));
    await key("Enter");
    await tripOptions();
    const from = await run(() => document.querySelector(".field-from input")?.value ?? "");
    ok(/position|Ma position|location/i.test(from), `start isn't my location ("${from}")`);
  });

  await step("'my location' follows a language switch (French, Darija, English)", async () => {
    // The start is "my location" from the step before; switch language in Settings and come back.
    const want = { fr: "Ma position", ar: "فين أنا", en: "My location" };
    for (const [lang, label] of [["Français", "fr"], ["الدارجة", "ar"], ["English", "en"], ["Français", "fr"]]) {
      await click(".map-btn");
      await until("settings", () => document.querySelector(".about .segmented"));
      await click(".about .segmented button", lang);
      await run(() => (history.back(), true));
      await until("the trip again", () => document.querySelector(".sheet.view-results .field-from input"));
      const shown = await run(() => document.querySelector(".field-from input").value);
      ok(shown.includes(want[label]), `in ${label} the start says "${shown}", not "${want[label]}"`);
    }
  });

  await step("search: recent places, then clear history", async () => {
    await open(SITE + "?recent");
    await openSearch();
    await until("recents", () => document.querySelector(".clear-history"));
    await click(".clear-history");
    await until("an empty list", () => !document.querySelectorAll(".results-list .row").length);
    ok(await run(() => localStorage.getItem("recent") === null), "recents still stored");
  });

  await step("search: a Google Maps link with coordinates", async () => {
    await typeSearch("Pharmacie test https://www.google.com/maps/place/Pharmacie/@30.4167,-9.5745,17z");
    await until("the 'Utiliser ce lieu' row", () => [...document.querySelectorAll(".sheet-body .row")].some((r) => /Utiliser ce lieu/.test(r.textContent) && /Pharmacie/.test(r.textContent)));
    await click(".sheet-body .row", "Utiliser ce lieu");
    await tripOptions();
    const to = await run(() => document.querySelector(".field-to input")?.value ?? "");
    ok(/Pharmacie/.test(to), `destination is "${to}"`);
  });

  await step("search: a Google share link that only has a plus code and a name", async () => {
    await open(SITE + "?pc");
    await openSearch();
    await typeSearch("https://maps.google.com/maps?q=CC65+5MW+Cabinet+de+Neurologie+Dr.+Latifa+Hadrane,+Agadir+80000&ftid=0xdb3b6f8b32adeef:0xe33fccab78366c34");
    await until("the 'Utiliser ce lieu' row", () => [...document.querySelectorAll(".sheet-body .row")].some((r) => /Utiliser ce lieu/.test(r.textContent) && r.getClientRects().length));
    await click(".sheet-body .row", "Utiliser ce lieu");
    await tripOptions();
    ok(/Latifa Hadrane/.test(await run(() => document.querySelector(".field-to input")?.value ?? "")), "destination isn't the practice");
  });

  await step("results: the ✕ clears the trip; back on home starts fresh", async () => {
    await open(SITE + "?clear" + TRIP);
    await tripOptions();
    await click(".planner-close");
    await until("an empty home", () => document.querySelector(".sheet.view-home") && document.querySelector(".sheet-body input")?.value === "");
    ok(await run(() => localStorage.getItem("lastTrip") === null && !location.hash), "the trip is still remembered");
    await open(SITE + "?clear2" + TRIP);
    await tripOptions();
    await run(() => (history.back(), true));
    await until("home", () => document.querySelector(".sheet.view-home"));
    ok(await run(() => document.querySelector(".sheet-body input")?.value === ""), "home still shows the old destination");
  });

  await step("shared to the app (?text=…) sets the destination", async () => {
    await open(SITE + "?text=" + encodeURIComponent("Pharmacie partagée\nhttps://www.google.com/maps/@30.4167,-9.5745,17z"));
    await tripOptions();
    ok(/Pharmacie partagée/.test(await run(() => document.querySelector(".field-to input")?.value ?? "")), "destination not set from the share");
  });

  await step("results: options, recommended, preferences, avoid walking, swap", async () => {
    await clearPrefs();
    await open(SITE + "?results" + TRIP);
    const n = await tripOptions();
    ok(n >= 2, `only ${n} option(s)`);
    ok(/Recommandé/.test(await text(".option:first-child .opt-tags")), "first option isn't 'Recommandé'");
    ok(/carte/.test(await text(".option .opt-meta")), "no card cost on the Trambus option");
    // Line badges stay compact pills (a broken shared style once made them tall blobs).
    const tall = await run(() => Math.max(...[...document.querySelectorAll(".option .badge")].map((b) => b.getBoundingClientRect().height)));
    ok(tall <= 40, `a line badge is ${Math.round(tall)}px tall`);
    // Times sit in direction marks (they read right inside Darija text): "⁦10:00⁩ – ⁦10:46⁩".
    // Each card, as in a maps app: leave – arrive, then when and where to get on, and the walk.
    ok(/\d\d:\d\d\D{0,3} – \D{0,3}\d\d:\d\d/.test(await text(".opt-clock")), `no leave – arrive times ("${await text(".opt-clock")}")`);
    ok(/Trambus à \D{0,3}\d\d:\d\d\D{0,3} de /.test(await text(".opt-catch")), `no "Trambus à HH:MM de <stop>" ("${await text(".opt-catch")}")`);
    ok(/De /.test(await text(".opt-catch")), "a bus card doesn't say which stop it leaves from");
    ok(/à pied/.test(await text(".opt-meta")), "no walk on the cards");
    // Route callouts on the map, as in a maps app: shown without overlapping, and a tap chooses that trip.
    await until("route callouts", () => document.querySelectorAll(".route-callout").length >= 2);
    await sleep(800);
    const lay = await run(() => {
      const cs = [...document.querySelectorAll(".route-callout")].filter((x) => x.style.visibility !== "hidden");
      const rs = cs.map((x) => x.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < rs.length; i++) for (let k = i + 1; k < rs.length; k++) if (rs[i].left < rs[k].right && rs[k].left < rs[i].right && rs[i].top < rs[k].bottom && rs[k].top < rs[i].bottom) overlaps++;
      return { shown: cs.length, overlaps };
    });
    ok(lay.shown >= 2 && lay.overlaps === 0, `callouts: ${JSON.stringify(lay)}`);
    await run(() => ([...document.querySelectorAll(".route-callout")].find((x) => !x.classList.contains("on") && x.style.visibility !== "hidden").click(), true));
    await until("the tapped trip chosen", () => document.querySelector(".option.chosen") && document.querySelectorAll(".route-callout.on").length === 1);
    await shot("results");
    await audit("results");
    // The route preference, in Options with the lines and modes.
    await run(() => ([...document.querySelectorAll(".trip-chip")][1].click(), true));
    ok(!(await run(() => !!document.querySelector(".pref-slider"))), "the time-vs-money slider is back");
    await shot("results-prefs");
    await audit("results, Options open");
    await click(".trip-panel .segmented button", "Moins de marche");
    await until("'Moins de marche' chosen", () => [...document.querySelectorAll(".trip-panel .segmented button")].some((b) => /Moins de marche/.test(b.textContent) && b.getAttribute("aria-pressed") === "true"));
    await click(".trip-panel .segmented button", "Moins de changements");
    await until("'Moins de changements' chosen", () => [...document.querySelectorAll(".trip-panel .segmented button")].some((b) => /Moins de changements/.test(b.textContent) && b.getAttribute("aria-pressed") === "true"));
    await until("counted in Options", () => /Options · 1/.test(document.querySelector(".trip-chips").textContent));
    await run(() => ([...document.querySelectorAll(".trip-chip")][1].click(), true));
    const [a, b] = await run(() => [document.querySelector(".field-from input").value, document.querySelector(".field-to input").value]);
    await click(".swap");
    await until("swapped", (a) => document.querySelector(".field-to input")?.value === a, 5000, a);
    ok((await run(() => document.querySelector(".field-from input").value)) === b, "swap didn't swap");
    await noSideways("results");
    await clearPrefs();
  });

  await step("same start and end says so", async () => {
    await open(SITE + "?same#from=-9.59810,30.42020,Ici&to=-9.59812,30.42022,Ici");
    await until("the message", () => /même endroit/.test(document.querySelector(".sheet-body").textContent));
  });

  const setWhen = async (seg, time) => {
    await click(".trip-chip", "");
    await run((seg) => ([...document.querySelectorAll(".trip-panel .segmented button")][seg].click(), true), seg);
    await run((time) => {
      // Tomorrow at that time, in the one day-and-time field.
      const d = new Date(Date.now() + 86400_000);
      const t = document.querySelector(".time-input");
      t.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${time}`;
      t.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".when-time button").click();
      return true;
    }, time);
  };

  await step("when: leave at tomorrow 07:30, then arrive by 08:00, then now", async () => {
    await open(SITE + "?when" + TRIP);
    await tripOptions();
    await click(".trip-chip", "");
    await audit("results, time panel open");
    await click(".trip-chip", "");
    await setWhen(1, "07:30");
    // Nothing leaves before 07:30 (a Trambus trip may leave a little later, timed to catch it).
    await until("07:30 departures", () => {
      const starts = [...document.querySelectorAll(".opt-clock")].map((e) => e.textContent.replace(/[^\d:–]/g, "").split("–")[0]);
      return starts.length && starts.every((x) => x >= "07:30" && x < "08:30");
    });
    ok(/Départ.*07:30.*Demain/.test(await text(".trip-chip")), `chip says "${await text(".trip-chip")}"`);
    await setWhen(2, "08:00");
    await until("leave-before times", () => document.querySelector(".opt-clock") && [...document.querySelectorAll(".opt-clock")].every((e) => /Partez avant/.test(e.textContent)));
    await click(".trip-chip", "");
    await run(() => ([...document.querySelectorAll(".trip-panel .segmented button")][0].click(), true));
    await until("back to now", () => /Partir maintenant/.test(document.querySelector(".trip-chip").textContent));
  });

  await step("when: no Trambus at 05:00", async () => {
    await setWhen(1, "05:00");
    await until("05:00 departures", () => /0[5-6]:\d\d/.test(document.querySelector(".opt-clock")?.textContent ?? ""));
    ok(!(await optionLines()).flat().includes("Trambus"), "a Trambus option at 05:00");
  });

  await step("late at night: the warning comes first, buses say they may not run, no line 26", async () => {
    await open(SITE + "?night" + TRIP);
    await tripOptions();
    await setWhen(1, "01:28");
    await until("night results", () => document.querySelector(".compare > .tip-night"));
    const first = await run(() => document.querySelector(".compare").firstElementChild.className);
    ok(/tip-night/.test(first), `the first thing in the results is "${first}", not the night warning`);
    ok(/Peut-être pas de bus/.test(await text(".opt-tag-warn")), "no 'may not run' tag on the buses");
    ok(!(await optionLines()).flat().includes("26"), "line 26 offered at 01:28 (it runs 06:30-21:00)");
  });

  await step("options: buses off, Trambus off, a line avoided, reset", async () => {
    await clearPrefs();
    await open(SITE + "?opts" + TRIP);
    await tripOptions();
    await run(() => ([...document.querySelectorAll(".trip-chip")][1].click(), true));
    await click(".trip-panel .setting-row", "Bus");
    await until("replanned", () => /Options · 1/.test(document.querySelector(".trip-chips").textContent));
    for (const lines of await optionLines()) for (const l of lines) ok(l === "Trambus", `a bus (${l}) with buses off`);
    await click(".trip-panel .setting-row", "Bus");
    await until("buses back", () => !/Options · /.test(document.querySelector(".trip-chips").textContent));
    await click(".trip-panel .setting-row", "Trambus");
    await until("replanned", () => /Options · 1/.test(document.querySelector(".trip-chips").textContent));
    ok(!(await optionLines()).flat().includes("Trambus"), "Trambus still offered");
    const bus = (await optionLines()).flat().find((l) => l !== "Trambus");
    ok(bus, "no bus line to avoid");
    await run((bus) => ([...document.querySelectorAll(".avoid-line")].find((b) => b.textContent.trim() === bus).click(), true), bus);
    await until("replanned", () => /Options · 2/.test(document.querySelector(".trip-chips").textContent));
    ok(!(await optionLines()).flat().includes(bus), `line ${bus} still offered`);
    await click(".trip-panel .link", "initialiser");
    await until("options reset", () => !/Options · /.test(document.querySelector(".trip-chips").textContent));
  });

  await step("trip: steps, card note, 'I have the card', stops list", async () => {
    await clearPrefs();
    await open(SITE + "?trip" + TRIP);
    await tripOptions();
    // The Trambus option, whichever rank it has.
    await run(() => ([...document.querySelectorAll(".option")].find((o) => /Trambus/.test(o.textContent)).click(), true));
    await until("the trip steps", () => document.querySelector(".tl-stop"));
    ok(await run(() => !!document.querySelector(".card-note")), "no card note");
    await shot("trip");
    await audit("trip");
    await click(".card-note .chip-toggle");
    await until("the note to go", () => !document.querySelector(".card-note"));
    await click(".tl-ride .link", "arrêts");
    ok(await run(() => !document.querySelector(".mini-stops").hidden), "the stops list didn't open");
    await run(() => (history.back(), true));
    await tripOptions();
    ok(!/carte/.test(await text(".option .opt-meta")), "card cost still shown after 'I have the card'");
    await clearPrefs();
  });

  await step("another stop: get on and get off where I choose, then undo", async () => {
    await open(SITE + "?pick" + TRIP);
    await tripOptions();
    await click(".option");
    await until("the trip", () => document.querySelector(".tl-other"));
    await click(".tl-other");
    await until("the stop list", () => document.querySelectorAll(".pick-stop .row").length > 4);
    await audit("pick a stop");
    const on = await run(() => {
      const row = document.querySelectorAll(".pick-stop .row")[4];
      const n = row.querySelector(".row-main span").textContent;
      row.click();
      return n;
    });
    await until("'Montée' chip", (n) => [...document.querySelectorAll(".trip-chip")].some((c) => c.textContent.includes(n)), 20000, on);
    await click(".option");
    await until("the trip", () => document.querySelectorAll(".tl-other").length);
    ok((await text(".tl-stop-name")).includes(on), `the trip doesn't get on at ${on}`);
    await run(() => ([...document.querySelectorAll(".tl-other")].at(-1).click(), true));
    await until("the stop list", () => document.querySelectorAll(".pick-stop .row").length > 2);
    await run(() => (document.querySelectorAll(".pick-stop .row")[2].click(), true));
    await until("two chips", () => document.querySelectorAll(".trip-chip.on").length >= 2);
    await run(() => ([...document.querySelectorAll(".trip-chip")].find((c) => /Montée/.test(c.textContent)).click(), true));
    await until("'Montée' gone", () => ![...document.querySelectorAll(".trip-chip")].some((c) => /Montée/.test(c.textContent)));
  });

  await step("a stop near the destination: 'Descendre ici'", async () => {
    await open(SITE + "?near" + TRIP);
    await tripOptions();
    await click(".stop-near .row");
    await until("the stop screen", () => document.querySelector(".stop"));
    await audit("stop");
    await click(".stop .btn", "Descendre ici");
    await until("'Descente' chip", () => [...document.querySelectorAll(".trip-chip")].some((c) => /Descente/.test(c.textContent)));
  });

  await step("ride mode: GPS along the line, stops left, get off, arrived", async () => {
    await clearPrefs();
    await open(SITE + "?ride" + TRIP);
    await tripOptions();
    await click(".option");
    await until("the trip", () => document.querySelector(".tl-board .badge"));
    const leg = await run(() => ({
      line: document.querySelector(".tl-board .badge").textContent.trim(),
      board: document.querySelector(".tl-stop .tl-stop-name").textContent.trim(),
      alight: document.querySelector(".tl-off .tl-stop-name").textContent.trim(),
    }));
    // The same line and stops in the app's own data, to drive the GPS along them.
    const net = await (await fetch(new URL("data/agadir.json", SITE))).json();
    const line = net.lines.find((l) => (l.brt ? "Trambus" : l.ref) === leg.line);
    let path;
    for (const v of line?.variants ?? []) {
      const names = v.stops.map((i) => net.stops[i].n.d);
      const a = names.indexOf(leg.board);
      const b = names.indexOf(leg.alight, a + 1);
      if (a >= 0 && b > a) path = v.stops.slice(a, b + 1).map((i) => net.stops[i].ll);
    }
    ok(path, `can't find ${leg.line} from ${leg.board} to ${leg.alight} in the data`);
    await click(".trip-start .btn-primary");
    await until("the ride screen", () => document.querySelector(".ride"));
    await where(...path[0]);
    await until("walking or waiting at the stop", () => document.querySelector(".ride-body")?.textContent.length > 0);
    const lefts = [];
    for (const ll of path.slice(1)) {
      await where(...ll);
      await sleep(400);
      const n = await run(() => Number(document.querySelector(".ride-big .num")?.textContent ?? -1));
      if (n >= 0) lefts.push(n);
    }
    await audit("ride");
    // What matters while riding is on screen, not under the bottom edge.
    const cut = await run(() => {
      const r = document.querySelector(".ride-big")?.getBoundingClientRect();
      return r ? r.bottom - innerHeight : 999;
    });
    ok(cut <= 0, `the stops-left line is ${Math.round(cut)}px below the screen`);
    // And the rider's own dot is on the visible map, above the panel.
    // Not under the panel (below it on a phone, beside it on a desktop) and on screen.
    const dot = await run(() => {
      const d = document.querySelector(".me-dot")?.getBoundingClientRect();
      const p = document.querySelector(".sheet").getBoundingClientRect();
      if (!d) return null;
      const x = d.left + d.width / 2, y = d.top + d.height / 2;
      return { x, y, covered: x >= p.left && x <= p.right && y >= p.top && y <= p.bottom, onScreen: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight };
    });
    ok(dot && !dot.covered && dot.onScreen, `my position is hidden (${JSON.stringify(dot)})`);
    ok(lefts.length >= 2, `stops-left count never showed (${lefts.join(",")})`);
    ok(lefts.every((n, i) => i === 0 || n <= lefts[i - 1]), `stops left went up: ${lefts.join(",")}`);
    await until("'Descendez ici'", () => /Descendez ici/.test(document.querySelector(".ride-body").textContent), 8000);
    await where(...DCHEIRA);
    await until("arrived", () => /Arriv/.test(document.querySelector(".ride-body").textContent), 8000);
    await where(...TALBORJT);
  });

  await step("far from any stop: looks further and says how far", async () => {
    // About 2.4 km from the nearest stop, north of Agadir.
    await open(SITE + "?far#from=-9.7500,30.5500,Loin&to=" + TALBORJT.join(",") + ",Talborjt");
    await tripOptions();
    ok(/premier arrêt est à/.test(await text(".tip-walk")), "no 'first stop is X on foot' note");
    ok((await optionLines()).some((l) => l.length), "no bus option, only walking");
  });

  await step("usual trips: a trip planned again shows on home, one tap plans it", async () => {
    // The trip was planned once, two hours ago; planning it now makes it usual.
    await run((k) => {
      localStorage.setItem("trips", JSON.stringify({ [k]: { from: { ll: [-9.5981, 30.4202], label: { d: "Talborjt" }, kind: "place" }, to: { ll: [-9.53, 30.395], label: { d: "Dcheira" }, kind: "place" }, n: 1, last: Date.now() - 7200_000 } }));
      return true;
    }, "-9.598,30.420>-9.530,30.395");
    await open(SITE + "?usual" + TRIP);
    await tripOptions();
    await run(() => (history.replaceState(null, "", location.pathname), localStorage.removeItem("lastTrip"), true));
    await open(SITE + "?home");
    await until("'Vos trajets'", () => /Vos trajets/.test(document.querySelector(".sheet-body").textContent) && document.querySelector(".usual .row"));
    await click(".usual .row");
    await tripOptions();
    ok(/Dcheira/.test(await run(() => document.querySelector(".field-to input").value)), "the usual trip didn't plan Dcheira");
  });

  await step("a line drawn from an announcement says so, with the stops not placed, its source and a report link; one in the operator's data doesn't", async () => {
    await open(SITE + "?council");
    await click(".sheet-body .row", "Toutes les lignes");
    await until("the lines list", () => document.querySelectorAll(".sheet-body .row").length > 30);
    const pick = (ref) => run((r) => ([...document.querySelectorAll(".sheet-body .row")].find((x) => x.querySelector(".badge")?.textContent.trim() === r).click(), true), ref);
    await pick("8B");
    await until("line 8B", () => document.querySelector(".line"));
    ok(/Tracé approximatif/.test(await text(".tip-unconfirmed")), "line 8B doesn't say its route is approximate");
    ok(/Hay Harrouchi/.test(await text(".tip-unconfirmed")), "line 8B doesn't name the stops not placed");
    ok(/ALSA Facebook/.test(await text(".provenance")), "no data source on line 8B");
    ok(await run(() => /template=data-correction/.test(document.querySelector(".provenance a")?.href ?? "")), "no report link on line 8B");
    await run(() => (history.back(), true));
    await until("the lines list again", () => !document.querySelector(".line") && document.querySelectorAll(".sheet-body .row").length > 30);
    await pick("2");
    await until("line 2", () => document.querySelector(".line"));
    ok(await run(() => !document.querySelector(".tip-unconfirmed")), "line 2's new terminus is drawn, so no notice");
  });

  await step("lines: list, a line, its other direction, a stop, back steps back", async () => {
    await open(SITE + "?lines");
    await click(".sheet-body .row", "Toutes les lignes");
    await until("the lines list", () => document.querySelectorAll(".sheet-body .row").length > 30);
    await run(() => ([...document.querySelectorAll(".sheet-body .row")].find((r) => r.querySelector(".badge")?.textContent.trim() === "32").click(), true));
    await until("line 32", () => document.querySelector(".line"));
    await audit("line");
    const dirs = await run(() => document.querySelectorAll(".line .segmented button").length);
    if (dirs > 1) {
      await run(() => ([...document.querySelectorAll(".line .segmented button")][1].click(), true));
      await until("the other direction", () => document.querySelector(".line .segmented button.on") === [...document.querySelectorAll(".line .segmented button")][1]);
    }
    await click(".line .row");
    await until("a stop", () => document.querySelector(".stop"));
    await run(() => (history.back(), true));
    await until("back on the line", () => document.querySelector(".line"));
    if (P.name === "desktop") {
      await key("Escape");
      await until("Escape goes back", () => !document.querySelector(".line") && document.querySelectorAll(".sheet-body .row").length > 30);
    }
  });

  await step("a stop: 'Prendre un bus ici' walks you there and plans from it", async () => {
    await open(SITE + "?catch");
    await click(".sheet-body .row", "Toutes les lignes");
    await until("the lines list", () => document.querySelectorAll(".sheet-body .row").length > 30);
    await run(() => ([...document.querySelectorAll(".sheet-body .row")].find((r) => r.querySelector(".badge")?.textContent.trim() === "5").click(), true));
    await until("line 5", () => document.querySelector(".line .row"));
    const stop = await run(() => {
      const row = document.querySelectorAll(".line .row")[3];
      const n = row.querySelector(".row-main span").textContent.trim();
      row.click();
      return n;
    });
    await until("the stop", () => document.querySelector(".stop .btn-take"));
    await audit("stop, no trip planned");
    await click(".stop .btn-take");
    await until("search for where to", () => document.querySelector(".sheet.view-search .sheet-body input"));
    await typeSearch("dcheira");
    await until("results for dcheira", () => /dche[iï]ra/i.test(document.querySelector(".results-list .row")?.textContent ?? ""));
    await click(".results-list .row");
    await tripOptions();
    ok((await text(".trip-chip")).includes(stop), `no 'Montée : ${stop}' chip`);
    ok(/position|Ma position/i.test(await run(() => document.querySelector(".field-from input")?.value ?? "")), "the start isn't my location");
  });

  await step("a Trambus stop shows its next passages (estimated)", async () => {
    await open(SITE + "?passes");
    await click(".sheet-body .row", "Port");
    await until("the Trambus line", () => document.querySelector(".line"));
    await run(() => (document.querySelectorAll(".line .row")[5].click(), true));
    await until("the stop", () => document.querySelector(".stop"));
    const passes = await until("passing times", () => document.querySelector(".stop-passes")?.textContent);
    ok(/10:\d\d.*10:\d\d/.test(passes), `passes at 10:00 are "${passes}"`);
    ok(/estimées/.test(await text(".stop .fine")), "no 'estimated' note");
    await audit("stop with passing times");
  });

  await step("a slow phone: typing in search before the map has loaded is kept", async () => {
    await send("Emulation.setCPUThrottlingRate", { rate: 6 }, s);
    try {
      await open(SITE + "?slowtype");
      await openSearch();
      await typeSearch("pharmacie");
      await until("the map", () => document.querySelector(".maplibregl-canvas")?.width > 0, 30000);
      await sleep(1500);
      ok((await run(() => document.querySelector(".sheet.view-search .sheet-body input")?.value)) === "pharmacie", "the typed search was erased when the map loaded");
    } finally {
      await send("Emulation.setCPUThrottlingRate", { rate: 1 }, s);
    }
  });

  await step("a slow phone: route callouts never show stacked, even before they're placed", async () => {
    await send("Emulation.setCPUThrottlingRate", { rate: 6 }, s);
    try {
      await open(SITE + "?slowcallouts" + TRIP);
      // From the moment the trips appear, look every 100 ms: no two visible callouts may overlap.
      const end = Date.now() + 4000;
      let worst = 0;
      while (Date.now() < end) {
        const n = await run(() => {
          const rs = [...document.querySelectorAll(".route-callout")].filter((x) => getComputedStyle(x).visibility !== "hidden").map((x) => x.getBoundingClientRect());
          let o = 0;
          for (let i = 0; i < rs.length; i++) for (let k = i + 1; k < rs.length; k++) if (rs[i].left < rs[k].right && rs[k].left < rs[i].right && rs[i].top < rs[k].bottom && rs[k].top < rs[i].bottom) o++;
          return o;
        });
        worst = Math.max(worst, n);
        await sleep(100);
      }
      ok(worst === 0, `${worst} pair(s) of visible callouts overlapped at some moment`);
      await until("callouts placed", () => [...document.querySelectorAll(".route-callout")].some((x) => getComputedStyle(x).visibility !== "hidden"), 20000);
    } finally {
      await send("Emulation.setCPUThrottlingRate", { rate: 1 }, s);
    }
  });

  await step("a slow phone: a line opened before the map has loaded", async () => {
    await send("Emulation.setCPUThrottlingRate", { rate: 6 }, s);
    try {
      await open(SITE + "?slow");
      await click(".sheet-body .row", "Toutes les lignes");
      await until("the lines list", () => document.querySelectorAll(".sheet-body .row").length > 30);
      await run(() => ([...document.querySelectorAll(".sheet-body .row")].find((r) => r.querySelector(".badge")?.textContent.trim() === "32").click(), true));
      await until("line 32", () => document.querySelector(".line"));
      await until("the map", () => document.querySelector(".maplibregl-canvas")?.width > 0, 30000);
      await sleep(1500);
    } finally {
      await send("Emulation.setCPUThrottlingRate", { rate: 1 }, s);
    }
  });

  await step("settings: languages, themes, Trambus switches, version", async () => {
    await open(SITE + "?settings");
    await click(".map-btn");
    await until("settings", () => document.querySelector(".setting-list"));
    ok(/Version [0-9a-f]{7}/.test(await text(".sheet-body .fine")), "no version line");
    ok(await run(() => !![...document.querySelectorAll(".gh-link")].find((a) => a.href === "https://github.com/zkousama/tobis")?.querySelector("svg")), "no GitHub link with its mark");
    ok(await run(() => [...document.querySelectorAll(".gh-link")].some((a) => a.href.includes("template=data-correction.yml"))), "no 'Signaler une erreur' link");
    // Sharing ride times is the rider's choice: the switch is there, and off until they turn it on.
    ok(await run(() => [...document.querySelectorAll(".setting-row")].find((b) => /Partager mes temps/.test(b.textContent))?.getAttribute("aria-checked") === "false"), "the ride-times switch is missing or on by default");
    await shot("settings");
    await audit("settings");
    await click(".about .segmented button", "English");
    await until("English", () => /Settings/.test(document.querySelector(".view-title").textContent) && /Menu/.test(document.querySelector(".map-btn").textContent));
    await click(".about .segmented button", "الدارجة");
    await until("Darija, right to left", () => document.documentElement.dir === "rtl");
    await click(".about .segmented button", "Français");
    await until("French", () => document.documentElement.dir === "ltr" && /Réglages/.test(document.querySelector(".view-title").textContent));
    await run(() => ([...document.querySelectorAll(".about .segmented")][1].querySelectorAll("button")[2].click(), true));
    const dark = await run(() => getComputedStyle(document.body).backgroundColor);
    await run(() => ([...document.querySelectorAll(".about .segmented")][1].querySelectorAll("button")[1].click(), true));
    const light = await run(() => getComputedStyle(document.body).backgroundColor);
    ok(dark !== light, `dark and light look the same (${dark})`);
    await run(() => ([...document.querySelectorAll(".about .segmented")][1].querySelectorAll("button")[0].click(), true));
    for (const label of ["J'ai la carte", "Ne pas proposer"]) {
      await click(".setting-row", label);
      ok(await run((l) => [...document.querySelectorAll(".setting-row")].find((r) => r.textContent.includes(l)).getAttribute("aria-checked") === "true", label), `${label}: switch didn't turn on`);
      await click(".setting-row", label);
    }
  });

  await step("help: every section", async () => {
    await open(SITE + "?help");
    await click(".sheet-body button, .sheet-body a", "Comment ça marche");
    await until("help", () => document.querySelector(".help"));
    const ids = await run(() => [...document.querySelectorAll(".help-section")].map((s) => s.id).join(","));
    for (const id of ["what", "cant", "find", "install", "offline", "location"]) ok(ids.includes(`help-${id}`), `no '${id}' section (${ids})`);
    await shot("help");
    await audit("help");
  });

  await step("Darija, right to left, dark: results", async () => {
    await look("dark");
    await setLang("ar");
    await open(SITE + "?ar" + TRIP);
    await tripOptions();
    ok((await run(() => document.documentElement.dir)) === "rtl", "page isn't right to left");
    await noSideways("Darija results");
    await shot("results-ar-dark");
    await audit("results in Darija, dark");
    await setLang("fr");
    await look("light");
  });

  await step("200 % text: nothing runs off the side", async () => {
    for (const [name, url] of [["home", SITE + "?big1"], ["results", SITE + "?big2" + TRIP]]) {
      await open(url);
      if (name === "results") await tripOptions();
      await run(() => ((document.documentElement.style.fontSize = "200%"), true));
      await noSideways(`${name} at 200 %`);
    }
  });

  await step("map: credit folds, stop labels stay on the map", async () => {
    await run(() => (localStorage.setItem("skipBrt", "1"), true));
    await open(SITE + "?map" + TRIP);
    await tripOptions();
    await until("the stop labels", () => document.querySelectorAll(".stop-badge span").length >= 2);
    await sleep(1500);
    const out = await run(() => {
      const box = document.querySelector(".maplibregl-map").getBoundingClientRect();
      return [...document.querySelectorAll(".stop-badge span")]
        .map((s) => ({ t: s.textContent, r: s.getBoundingClientRect() }))
        .filter(({ r }) => r.right > box.right + 1 || r.left < box.left - 1)
        .map(({ t, r }) => `${t} (${Math.round(r.left)}–${Math.round(r.right)} of ${Math.round(box.width)})`);
    });
    ok(!out.length, `stop label off the map: ${out.join(", ")}`);
    await until("the credit folded", () => !document.querySelector(".maplibregl-ctrl-attrib.maplibregl-compact-show"), 9000);
    await clearPrefs();
  });

  await step("reopening brings back the last trip", async () => {
    await open(SITE + "?last" + TRIP);
    await tripOptions();
    await open(SITE);
    await until("the trip again", () => document.querySelector(".sheet.view-results") && document.querySelector(".option"));
  });

  await step("offline: opens, plans, shows the banner, explains short links", async () => {
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);
    problems.length = 0;
    await open(SITE + "?offline" + TRIP);
    await tripOptions();
    await until("the map offline", () => document.querySelector(".maplibregl-canvas")?.width > 0);
    // The banner follows the network state once the app has read it: wait for it rather than check at once.
    await until("the offline banner", () => !document.querySelector(".offline-banner").hidden, 8000).catch(() => {
      throw new Error("no offline banner");
    });
    await audit("offline");
    await open(SITE + "?offline2");
    await openSearch();
    await typeSearch("https://maps.app.goo.gl/AbCdEf123");
    await until("the 'Utiliser ce lieu' row", () => [...document.querySelectorAll(".sheet-body .row")].some((r) => /Utiliser ce lieu/.test(r.textContent) && r.getClientRects().length), 8000).catch(async () => {
      throw new Error(`no visible link row: ${await run(() => JSON.stringify({ view: document.querySelector(".sheet").className, input: document.querySelector(".sheet-body input")?.value, inputs: document.querySelectorAll(".sheet-body input").length, rows: [...document.querySelectorAll(".sheet-body .row")].map((r) => `${r.getClientRects().length ? "" : "(hidden) "}${r.textContent.slice(0, 50)}`) }))}`);
    });
    await run(() => {
      window.__flashes = [];
      new MutationObserver(() => window.__flashes.push(document.querySelector(".toast").textContent)).observe(document.querySelector(".toast"), { childList: true, characterData: true, subtree: true });
      window.__onLineAtClick = navigator.onLine; // reported if the check fails
      return true;
    });
    await click(".sheet-body .row", "Utiliser ce lieu");
    // Every message shown since the tap (a later one can replace it before we look).
    await until("the 'needs internet' message", () => window.__flashes.some((f) => /internet/i.test(f)), 5000).catch(async () => {
      throw new Error(`no 'needs internet' message; shown: ${await run(() => JSON.stringify({ onLineAtTap: window.__onLineAtClick, messages: window.__flashes }))}`);
    });
    await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);
  });

  listeners.splice(listeners.indexOf(onEvent), 1);
  await send("Target.closeTarget", { targetId }).catch(() => {});
  await send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
}

// The sheet and the map buttons, element by element: what a style change would move.
function snapshot() {
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
}
