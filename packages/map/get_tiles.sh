#!/usr/bin/env bash
#
# Build the placeholder Greece basemap and put it into the local R2 bucket at
# the object `PMTILES_GREECE` names.
#
# The archive is deliberately not in git (`*.pmtiles` is ignored): a fresh
# checkout has no basemap and `/map` shows the red "basemap could not be loaded"
# banner with the pins still drawn. Run this once to get the real thing.
#
#   pnpm map:tiles            # extract, then upload to the LOCAL R2 state
#   pnpm map:tiles:remote     # upload the same archive to the REMOTE bucket
#
# Requires the Protomaps CLI. `go install` names the binary `go-pmtiles`;
# `PMTILES_BIN` can point at any equivalent (a renamed `pmtiles`, for example).
#
#   go install github.com/protomaps/go-pmtiles@latest
#   export PATH="$PATH:$(go env GOPATH)/bin"
#
# Environment overrides: R2_BUCKET, R2_KEY, MAXZOOM, REGION, TARGET, REMOTE,
# PMTILES_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BUCKET="${R2_BUCKET:-estia}"
# The default object `PMTILES_GREECE` points at (wrangler.jsonc): the placeholder
# this script writes is the archive the page reads.
KEY="${R2_KEY:-maps/greece.pmtiles}"
REGION="${REGION:-packages/map/greece.json}"
# 11 is the ~39 MB dev placeholder. `MAXZOOM=14` matches the production shape
# (street labels) at several times the size.
MAXZOOM="${MAXZOOM:-11}"
TARGET="${TARGET:-packages/map/greece-dev.pmtiles}"
BUILDS_URL="https://build-metadata.protomaps.dev/builds.json"

if [ -z "${PMTILES_BIN:-}" ]; then
  if command -v pmtiles >/dev/null 2>&1; then
    PMTILES_BIN="pmtiles"
  elif command -v go-pmtiles >/dev/null 2>&1; then
    PMTILES_BIN="go-pmtiles"
  fi
fi

if [ -z "${PMTILES_BIN:-}" ]; then
  cat >&2 <<'EOF'
error: the Protomaps CLI is not installed.

  go install github.com/protomaps/go-pmtiles@latest
  export PATH="$PATH:$(go env GOPATH)/bin"

See packages/map/README.md. Set PMTILES_BIN if you installed it elsewhere.
EOF
  exit 1
fi

# Protomaps prunes old daily builds, so never hard-code a build URL: read the
# published list and take the newest `uploaded` entry.
echo "==> reading the published build list"
BUILD="$(curl -fsSL "$BUILDS_URL" | node -e '
  let body = "";
  process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
    const builds = JSON.parse(body);
    const newest = builds.reduce((best, build) =>
      best === undefined || build.uploaded > best.uploaded ? build : best,
    undefined);
    if (newest === undefined) {
      console.error("no builds listed");
      process.exit(1);
    }
    process.stdout.write("https://build.protomaps.com/" + newest.key);
  });
')"
echo "==> newest build: ${BUILD}"

echo "==> extracting Greece (maxzoom ${MAXZOOM}) to ${TARGET}"
"$PMTILES_BIN" extract "$BUILD" "$TARGET" --region="$REGION" --maxzoom="$MAXZOOM"

SIZE="$(wc -c < "$TARGET" | tr -d ' ')"
echo "==> extracted ${SIZE} bytes"

if [ "${REMOTE:-0}" = "1" ]; then
  WHERE="--remote"
  echo "==> uploading ${TARGET} to the REMOTE bucket as ${BUCKET}/${KEY}"
else
  WHERE="--local"
  echo "==> uploading ${TARGET} to the LOCAL bucket as ${BUCKET}/${KEY}"
fi

pnpm exec wrangler r2 object put "${BUCKET}/${KEY}" \
  --file "$TARGET" \
  --content-type application/vnd.pmtiles \
  "$WHERE"

echo "==> done. Start the dev server and open /map."
