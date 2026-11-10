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
(`estia`) as `maps/greece.pmtiles`, the object path `PMTILES_GREECE` names by
default.

Useful overrides: `MAXZOOM` (14 is the production shape, with street labels, at
several times the size), `REGION`, `TARGET`, `R2_BUCKET`, `R2_KEY`, `REMOTE=1`,
and `PMTILES_BIN` when the Protomaps CLI is not on `PATH` (the `go install`
above names the binary `go-pmtiles`; the script looks for both names).

## How the page finds it

The Worker route `GET /maps/:key` serves the archive from R2 with byte-range
support, and `PMTILES_GREECE` (a Worker var in `wrangler.jsonc`, default
`/maps/greece.pmtiles`) tells the page where to read it. `pnpm map:tiles` seeds
that same R2 object key, so the placeholder it writes is the one the page loads.
Swapping in the supplied archive needs no code change: set `PMTILES_GREECE` to
the archive you supply (upload it to the object the var names, or point the var
at any PMTiles URL). If the value points at a missing archive the page keeps its
degraded banner and still draws the pins.

## Attribution

The basemap data is ODbL. `/map` keeps "Basemap © OpenStreetMap contributors
(ODbL), tiles by Protomaps" visible under the map; do not remove it.
