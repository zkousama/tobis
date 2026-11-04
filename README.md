# Tobis

Trip planner for the buses and the Amalway Trambus in Greater Agadir (tobis is Darija for bus). Live at [tobis.pages.dev](https://tobis.pages.dev). It tells you which bus to take, where to wait for it, how many stops to ride, where to get off and how far to walk. Once it has loaded it works with no internet: the map, the search, the route finder and the live ride mode all run on the phone.

French, Darija and English.

## How it works

- **Route finder**: a round-based search (like RAPTOR) over every line and direction, with up to two changes. There are no official timetables for most lines, so waits and ride times are estimates: the Trambus runs every 10 minutes, and ride time comes from the distance between stops.
- **Walking**: real street distances and paths from a compact street graph shipped with the app (`public/data/agadir-walk.bin`).
- **Map**: a vector map of Greater Agadir cut out of the Protomaps world build (`public/basemap/agadir.pmtiles`), read in pieces from the offline cache.
- **Ride mode**: follows you along the line with GPS, counts the stops left and vibrates before yours.
- **Search**: neighbourhoods, streets, stops, shops, pharmacies, clinics and more, offline. A Google Maps link (shared or pasted), a plus code or coordinates also work. Short `maps.app.goo.gl` links are opened by `functions/api/expand.js`, a Cloudflare Pages Function, so they need a connection.

## Data

| What | Source | Licence |
|---|---|---|
| Lines, stop order, fares | ALSA Agadir, the public data behind alsa.ma/fr/agadir (`scripts/fetch-alsa.mjs`) | © ALSA, used as published |
| Trambus stations, frequency, fare | beta.amalway.ma, stations as mapped in OpenStreetMap | © Amalway / ODbL |
| Streets, stops, places | OpenStreetMap | ODbL 1.0 |
| More places (shops, clinics, offices) | Overture Maps, places theme | CDLA-Permissive-2.0 |
| Base map | Protomaps daily build, from OpenStreetMap | ODbL 1.0 |

The built data in `public/data/` is a derived database of OpenStreetMap and is available under the ODbL.

Where OpenStreetMap's bus routes are incomplete, the build says so in `data/reports/agadir.json`, and `scripts/osm-draft-trambus.mjs` writes a JOSM file that fills in the Trambus routes for review and upload.

## Build

```sh
bun install
node scripts/fetch-osm.mjs agadir          # OpenStreetMap snapshot into data/raw/agadir/
node scripts/fetch-alsa.mjs                 # ALSA lines and fares
overturemaps download --bbox=-9.95,29.92,-9.08,30.78 --type=place -f geojsonseq -o data/raw/agadir/overture/places.geojsonseq
node scripts/extract-basemap.mjs agadir 15  # offline map
node scripts/build-data.mjs agadir          # network, places, quality report
node scripts/build-walk.mjs agadir          # walking graph
bun run check                               # types, lint, tests
bun run build
```

`overturemaps` is the Overture Maps Python CLI (`pip install overturemaps`).

## Deploy

Both commands run the checks and the build first, and stop if either fails.

```sh
bun run deploy:preview   # preview.tobis.pages.dev: try it on a phone first
bun run deploy:live      # tobis.pages.dev
```

Installed copies pick up a new version the next time they open with signal. Only the files that changed are downloaded (`precache.json` lists a fingerprint per file). The new version takes over while the app is opening; if it's already in use, it shows a "new version" message and switches when tapped, so a page that's open never loses its files mid-trip. Settings shows the version, so a bug report can say which build it came from. The build fails if the offline copy grows past 30 MiB. `public/_headers` sets the security policy and keeps `sw.js` and `precache.json` uncached; a change to it is a new version too.

Other cities: add a `cities/<id>.json` with its bounding box and networks, and run the same scripts with that id.

## Grands taxis

Shared taxis have no published routes or fares, so they come from a list kept by hand: `data/taxis/agadir-grands-taxis.csv`. Each row is a stand (prefilled from OpenStreetMap) and one destination. Fill in `to` and `price_dh` (per seat); add `to_lat`/`to_lon` if the destination stand isn't the town centre; set `both_ways` to `no` for one-way routes. Rows without a price are left out. Rebuild with `node scripts/build-data.mjs agadir`.

Taxis: only the airport's fixed fares (published by ONDA) are shown. Petits taxis need Agadir's official meter tariff in `cities/agadir.json` (`petitTaxi`: start, perKm, minFare, night, nightFrom, nightTo) before the app shows them.

## Licence

The code is MIT (see `LICENSE`). The data keeps the licences listed above.
