// Cloudflare Pages Function: GET /api/expand?u=<maps.app.goo.gl link>
// Follows a Google Maps short link's redirects and returns where it lands,
// plus the coordinates when they can be read. Browsers can't do this
// themselves (cross-origin redirects), so the app asks here, online only.
const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/;
const GOOGLE_HOSTS = /^((www|maps)\.)?google\.[a-z.]+$|^(maps\.app\.goo\.gl|goo\.gl|g\.co|consent\.google\.com)$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": status === 200 ? "public, max-age=86400" : "no-store" },
  });

function coordsFrom(text) {
  const s = decodeURIComponent(text);
  const pin = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(s);
  if (pin) return { lat: +pin[1], lng: +pin[2] };
  const q = /[?&](?:q|query|ll|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(s);
  if (q) return { lat: +q[1], lng: +q[2] };
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s);
  if (at) return { lat: +at[1], lng: +at[2] };
  return null;
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url).searchParams.get("u");
  let url;
  try {
    url = new URL(u);
  } catch {
    return json({ error: "bad url" }, 400);
  }
  if (url.protocol !== "https:" || !SHORT_HOSTS.test(url.hostname)) return json({ error: "only Google Maps short links" }, 400);

  let current = url.href;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36" } });
    const next = res.headers.get("location");
    if (!next) {
      // Landed: try the page itself (its preview image carries the centre).
      const found = coordsFrom(current);
      if (found) return json({ url: current, ...found });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
        const html = (await res.text()).slice(0, 400_000);
        const og = /center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/.exec(html);
        if (og) return json({ url: current, lat: +og[1], lng: +og[2] });
      }
      return json({ url: current });
    }
    const target = new URL(next, current);
    if (!GOOGLE_HOSTS.test(target.hostname)) return json({ error: "redirect left Google" }, 400);
    // Google's consent page wraps the real destination in ?continue=.
    current = target.hostname === "consent.google.com" && target.searchParams.get("continue") ? target.searchParams.get("continue") : target.href;
    const found = coordsFrom(current);
    if (found) return json({ url: current, ...found });
  }
  return json({ url: current });
}
