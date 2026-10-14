#!/usr/bin/env bash
#
# Deterministic end-to-end test entrypoint for estia (`pnpm test:e2e`).
#
# 1. Applies the local D1 migrations.
# 2. Runs the rooms repository integration test against a real D1 engine.
# 3. Boots the real Vite/Cloudflare dev server, verifies the Tailscale
#    hostname passes Vite's host validation, and runs the HTTP smoke
#    checklist end to end.
#
# The dev server and its workerd child are always torn down on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${ESTIA_TEST_PORT:-8794}"
LOG="$(mktemp -t estia-test-dev.XXXXXX.log)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # Kill the whole process group so Vite's workerd child exits too.
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL -- "-$SERVER_PID" 2>/dev/null || kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

echo "==> applying local D1 migrations"
pnpm exec wrangler d1 migrations apply DB --local >/dev/null

echo "==> rooms repository integration test"
node scripts/room-repo-integration.mjs

echo "==> starting dev server on port ${PORT}"
set -m
pnpm exec vite dev --host --port "$PORT" >"$LOG" 2>&1 &
SERVER_PID=$!
set +m

BASE_URL="http://127.0.0.1:${PORT}"
healthy=""
for _ in $(seq 1 90); do
  if curl -fsS -m 2 -o /dev/null "${BASE_URL}/api/health" 2>/dev/null; then
    healthy=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "dev server exited before becoming healthy" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 1
done
[ -n "$healthy" ] || { echo "dev server did not become healthy" >&2; cat "$LOG" >&2; exit 1; }

echo "==> verifying Tailscale hostname passes Vite host validation"
HOST_CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: server:5174' "${BASE_URL}/api/health")"
[ "$HOST_CODE" = "200" ] || { echo "Host: server:5174 rejected with HTTP ${HOST_CODE}" >&2; exit 1; }
BLOCKED_CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "${BASE_URL}/api/health")"
[ "$BLOCKED_CODE" = "403" ] || { echo "unknown Host unexpectedly allowed (HTTP ${BLOCKED_CODE})" >&2; exit 1; }

echo "==> HTTP smoke checklist"
BASE_URL="$BASE_URL" bash scripts/smoke.sh

echo "all estia tests passed"
