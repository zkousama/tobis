// Turning what people paste into a position: Google Maps links, plus codes,
// "geo:" URIs and plain coordinates. All of it works offline except short
// links (maps.app.goo.gl), which only the network can unshorten.
import type { LngLat } from "./geo.ts";

export interface Parsed {
  ll?: LngLat;
  name?: string;
  shortUrl?: string; // needs expanding online first
}

const ALPHABET = "23456789CFGHJMPQRVWX";
const PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];

/** Decode a full Open Location Code to the centre of its area. */
export function decodePlusCode(code: string): LngLat | undefined {
  const clean = code.toUpperCase().replace(/0+\+?$/, "").replace("+", "");
  if (clean.length < 2 || clean.length > 15 || [...clean].some((c) => !ALPHABET.includes(c))) return;
  let lat = -90, lng = -180;
  let latRes = 0, lngRes = 0;
  for (let i = 0; i < Math.min(clean.length, 10); i += 2) {
    const r = PAIR_RES[i / 2];
    lat += ALPHABET.indexOf(clean[i]) * r;
    if (clean[i + 1] === undefined) return;
    lng += ALPHABET.indexOf(clean[i + 1]) * r;
    latRes = lngRes = r;
  }
  for (let i = 10; i < clean.length; i++) {
    latRes /= 5;
    lngRes /= 4;
    const d = ALPHABET.indexOf(clean[i]);
    lat += Math.floor(d / 4) * latRes;
    lng += (d % 4) * lngRes;
  }
  return [lng + lngRes / 2, lat + latRes / 2];
}

function encodePlusCode(lat: number, lng: number, length = 10): string {
  let la = Math.min(89.9999999, Math.max(-90, lat)) + 90;
  let lo = (((lng + 180) % 360) + 360) % 360;
  let out = "";
  for (let i = 0; i < length / 2; i++) {
    const r = PAIR_RES[i];
    const a = Math.floor(la / r);
    const b = Math.floor(lo / r);
    la -= a * r;
    lo -= b * r;
    out += ALPHABET[a] + ALPHABET[b];
    if (out.length === 8) out += "+";
  }
  return out;
}

/** Recover a short plus code ("8C7J+XX") using a nearby reference point. */
export function recoverPlusCode(short: string, ref: LngLat): LngLat | undefined {
  const s = short.toUpperCase();
  const sep = s.indexOf("+");
  if (sep < 0) return;
  if (sep >= 8) return decodePlusCode(s);
  const padding = 8 - sep;
  const resolution = 20 ** (2 - padding / 2);
  const half = resolution / 2;
  const full = encodePlusCode(ref[1], ref[0]).slice(0, padding) + s;
  const c = decodePlusCode(full);
  if (!c) return;
  let [lng, lat] = c;
  if (ref[1] + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (ref[1] - half > lat && lat + resolution <= 90) lat += resolution;
  if (ref[0] + half < lng) lng -= resolution;
  else if (ref[0] - half > lng) lng += resolution;
  return [lng, lat];
}

const num = (s: string) => Number(s);
const valid = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Coordinates and place name inside a Google Maps URL, if any. */
export function parseMapsUrl(raw: string): Parsed {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {};
  }
  const host = url.hostname.replace(/^www\./, "");
  // Short links, including share.google, which Google's share button gives out since 2025.
  if (/^(maps\.app\.goo\.gl|goo\.gl|g\.co|share\.google)$/.test(host)) return { shortUrl: url.href };
  const s = decodeURIComponent(url.href);
  const name = /\/place\/([^/@]+)/.exec(url.pathname)?.[1];
  const label = name ? decodeURIComponent(name).replace(/\+/g, " ").trim() : undefined;
  // The pin itself (!3d lat !4d lng) beats the viewport centre (@lat,lng).
  const pin = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(s);
  if (pin && valid(num(pin[1]), num(pin[2]))) return { ll: [num(pin[2]), num(pin[1])], name: label };
  for (const key of ["q", "query", "ll", "center", "destination", "daddr"]) {
    const v = url.searchParams.get(key);
    const m = v && /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(v);
    if (m && valid(num(m[1]), num(m[2]))) return { ll: [num(m[2]), num(m[1])], name: label };
  }
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s);
  if (at && valid(num(at[1]), num(at[2]))) return { ll: [num(at[2]), num(at[1])], name: label };
  return label ? { name: label } : {};
}

/**
 * Anything a person might paste or share: a Google Maps link (with or without
 * the text Google adds around it), a plus code, a geo: URI or "lat, lng".
 */
export function parseInput(text: string, ref: LngLat): Parsed {
  const t = text.trim();
  if (!t) return {};
  const urlMatch = /(https?:\/\/\S+)/.exec(t);
  if (urlMatch) {
    const parsed = parseMapsUrl(urlMatch[1]);
    // Google's share text puts the place name before the link.
    const before = t.slice(0, urlMatch.index).trim().replace(/[\s,:-]+$/, "");
    if (!parsed.name && before) parsed.name = before.split("\n")[0];
    return parsed;
  }
  const geo = /^geo:(-?\d+\.?\d*),(-?\d+\.?\d*)(?:\?q=([^&]+))?/i.exec(t);
  if (geo && valid(num(geo[1]), num(geo[2]))) return { ll: [num(geo[2]), num(geo[1])], name: geo[3] ? decodeURIComponent(geo[3]) : undefined };
  const pc = /\b([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3})\b/i.exec(t);
  if (pc) {
    const ll = recoverPlusCode(pc[1], ref);
    if (ll) return { ll, name: pc[1].toUpperCase() };
  }
  const xy = /^\s*(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})\s*$/.exec(t);
  if (xy && valid(num(xy[1]), num(xy[2]))) return { ll: [num(xy[2]), num(xy[1])] };
  return {};
}

/** Ask our small server function to unshorten a maps.app.goo.gl link (online only). */
export async function expandShortUrl(shortUrl: string): Promise<Parsed> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/expand?u=${encodeURIComponent(shortUrl)}`);
  if (!res.ok) throw new Error(`expand: HTTP ${res.status}`);
  const j = (await res.json()) as { url?: string; lat?: number; lng?: number; name?: string };
  if (j.lat !== undefined && j.lng !== undefined) return { ll: [j.lng, j.lat], name: j.name };
  return j.url ? parseMapsUrl(j.url) : {};
}
