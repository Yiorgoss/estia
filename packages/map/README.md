# Map basemap

`/map` renders published listing pins over a Protomaps basemap of Greece. The
vector archive itself is **not in git** (`*.pmtiles` is ignored and the file is
tens of megabytes), so a fresh checkout has no basemap: the page shows the red
"the basemap could not be loaded" banner and still draws the pins on a plain
background.

## Build the placeholder archive

```bash
go install github.com/protomaps/go-pmtiles@latest
export PATH="$PATH:$(go env GOPATH)/bin"

pnpm map:tiles          # extract Greece, upload to the local R2 bucket
pnpm map:tiles:remote   # same archive, upload to the deployed bucket
```

`pnpm map:tiles` reads the newest published Protomaps build from
`build-metadata.protomaps.dev` (never a hard-coded build date, because old daily
builds are pruned), extracts the region in `greece.json` with `MAXZOOM=11` into
`greece-dev.pmtiles`, and uploads it to the existing R2 `STORAGE` bucket
(`estia`) as `maps/greece.pmtiles`.

Useful overrides: `MAXZOOM` (14 is the production shape, with street labels, at
several times the size), `REGION`, `TARGET`, `R2_BUCKET`, `R2_KEY`, `REMOTE=1`.

## How the page finds it

The Worker route `GET /maps/:key` serves the archive from R2 with byte-range
support, and `MAP_BASEMAP_URL` (a Worker var, default `/maps/greece.pmtiles`)
tells the page where to read it. Swapping in the captain's real archive needs no
code change: upload it to `maps/greece.pmtiles`, or point `MAP_BASEMAP_URL` at
any PMTiles URL.

## Attribution

The basemap data is ODbL. `/map` keeps "Basemap © OpenStreetMap contributors
(ODbL), tiles by Protomaps" visible under the map; do not remove it.
