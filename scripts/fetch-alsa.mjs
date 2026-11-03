// Downloads ALSA Agadir's public network data (lines, stops in order, fares,
// first/last bus and frequency where published) into data/raw/agadir/alsa/.
// These are the same requests alsa.ma/fr/agadir/lignes makes in a browser.
import { writeFile, mkdir } from "node:fs/promises";

const BASE = "https://www.alsa.ma/fr/agadir/horaires?p_p_id=com_babel_alsa_ma_portlet_ServiceInformationPortlet&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&p_p_resource_id=";
const P = "_com_babel_alsa_ma_portlet_ServiceInformationPortlet_";
const CITY = 2; // Agadir
const OUT = "data/raw/agadir/alsa";
const UA = "agadir-bus-data/0.1 (open-source offline bus planner)";

async function get(cmd, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + cmd, {
        method: body ? "POST" : "GET",
        headers: { "user-agent": UA, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}
const pause = () => new Promise((r) => setTimeout(r, 700)); // be gentle with their server

await mkdir(OUT, { recursive: true });
const lines = JSON.parse(await get("MarruecosGetLinesFromCityResourceCommand"));
await writeFile(`${OUT}/lines.json`, JSON.stringify(lines));
console.log(`${lines.lines.length} lines`);

const extra = {};
for (const l of lines.lines) {
  await pause();
  const horario = await get("MarruecosGetHorarioArticleResourceCommand", `${P}cityId=${CITY}&${P}lineId=${encodeURIComponent(l.id)}`);
  await pause();
  const tarifa = await get("MarruecosGetTarifaArticleResourceCommand", `${P}cityId=${CITY}&${P}lineId=${encodeURIComponent(l.id)}&${P}idModoTarifa=1`);
  const parse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return t ? { raw: t } : null;
    }
  };
  extra[l.id] = { horario: parse(horario), tarifa: parse(tarifa) };
  const filled = (horario.match(/"(inicio|fin|frecuencia)":\s*"[^"]+"/g) ?? []).length;
  console.log(`  ${l.id.padEnd(6)} timetable values: ${String(filled).padStart(2)}  fare: ${tarifa.replace(/\s+/g, " ").slice(0, 90)}`);
}
await writeFile(`${OUT}/details.json`, JSON.stringify(extra, null, 1));
await writeFile(`${OUT}/fetched-at.txt`, new Date().toISOString() + "\n");
