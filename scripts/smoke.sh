#!/usr/bin/env bash
#
# Phase 3 smoke checklist for the Effect v4 migration.
#
# Prerequisites:
#   1. Local D1 migrations applied:
#        pnpm exec wrangler d1 migrations apply DB --local
#   2. A local D1 dev database seeded with `JWT_SECRET`, `DOMAIN` and
#      `ENVIRONMENT` (see `.dev.vars`).
#   3. The Worker running on $BASE_URL, e.g.:
#        pnpm exec wrangler dev --port 8799 --ip 127.0.0.1 --local
#
# Usage: BASE_URL=http://127.0.0.1:8799 ./scripts/smoke.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8799}"
DB_BINDING="${DB_BINDING:-DB}"

case "$BASE_URL" in
  http://127.0.0.1*|http://localhost*) ;;
  *) echo "refusing to run against non-local BASE_URL: $BASE_URL" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; exit 1; }

assert_status() {
  [ "$1" = "$2" ] || fail "$3 (expected HTTP $2, got $1)"
  pass "$3"
}

cookie_value() {
  # $1: header file, $2: cookie name
  sed -nE "s/^[Ss]et-[Cc]ookie: ${2}=([^;]+);.*/\1/p" "$1" | head -1 | tr -d '\r'
}

cookie_flags() {
  # $1: header file, $2: cookie name
  grep -i "^set-cookie: ${2}=" "$1" | head -1 | tr -d '\r'
}

EMAIL="smoke-$(date +%s)@test.local"
PASSWORD="correct horse battery staple"

echo "smoke test against ${BASE_URL}"

# 1. health
CODE=$(curl -s -o "$WORK/health" -w '%{http_code}' "${BASE_URL}/api/health")
assert_status "$CODE" 200 "health"
[ "$(cat "$WORK/health")" = "OK" ] || fail "health body"
pass "health body"

# 2. register (fresh user) and check cookie flags
CODE=$(curl -s -D "$WORK/register.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")
assert_status "$CODE" 200 "register"

ACCESS_H=$(cookie_flags "$WORK/register.h" access_token)
REFRESH_H=$(cookie_flags "$WORK/register.h" refresh_token)
printf '%s' "$ACCESS_H" | grep -qi 'httponly' || fail "access_token missing HttpOnly"
printf '%s' "$ACCESS_H" | grep -qi 'secure'   || fail "access_token missing Secure"
printf '%s' "$REFRESH_H" | grep -qi 'secure'  || fail "refresh_token missing Secure"
printf '%s' "$REFRESH_H" | grep -qi 'httponly' || fail "refresh_token missing HttpOnly"
pass "register cookie flags (access HttpOnly+Secure, refresh HttpOnly+Secure)"

ACCESS="$(cookie_value "$WORK/register.h" access_token)"
REFRESH="$(cookie_value "$WORK/register.h" refresh_token)"
[ -n "$ACCESS" ] && [ -n "$REFRESH" ] || fail "register cookies present"

# 3. unauthenticated rejection
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/users/me")
assert_status "$CODE" 401 "unauthenticated /api/users/me rejected"

# 4. seed a profile for the fresh user, then current-user
USER_ID="$(node -e '
  const token = process.argv[1];
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  process.stdout.write(String(payload.id));
' "$ACCESS")"
pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "INSERT OR IGNORE INTO seekers (user_id, name, bio, date_of_birth, gender, smoking, pets) VALUES ('${USER_ID}', 'Smoke User', NULL, 946684800000, 'NB', 1, 0);" \
  >/dev/null 2>&1 || fail "seed seeker profile"
pass "seed seeker profile"

CODE=$(curl -s -o "$WORK/me" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "current-user /api/users/me"
grep -q '"userProfile"' "$WORK/me" || fail "current-user response has userProfile"
pass "current-user response shape"

# 5. rooms round-trip: seed a lister + room, then read it back through the API
ROOM_LOCATION="Smokeville-$(date +%s)"
pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "INSERT OR IGNORE INTO listers (user_id, name, ownership) VALUES ('${USER_ID}', 'Smoke Lister', 'owner'); INSERT INTO rooms (lister_id, price, location, description, size, furnished, ensuite, smoking, pets, available_from) SELECT id, 500, '${ROOM_LOCATION}', 'smoke room', 20, 1, 0, 0, 1, 946684800000 FROM listers WHERE user_id='${USER_ID}';" \
  >/dev/null 2>&1 || fail "seed room"
pass "seed room"

ROOM_ID="$(pnpm exec wrangler d1 execute "$DB_BINDING" --local --json \
  --command "SELECT id FROM rooms WHERE location='${ROOM_LOCATION}' ORDER BY id DESC LIMIT 1;" 2>/dev/null \
  | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s)[0].results[0].id)))')"
[ -n "$ROOM_ID" ] || fail "room id"

CODE=$(curl -s -o "$WORK/room" -w '%{http_code}' "${BASE_URL}/api/rooms/${ROOM_ID}" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "get room by id"
grep -q "\"location\":\"${ROOM_LOCATION}\"" "$WORK/room" || fail "room response has the seeded location"
pass "room response shape"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/rooms/99999999" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 404 "unknown room rejected"

# 5b. room search is public and must not be shadowed by /api/rooms/:id
SEARCH_QUERY="minPrice=500&maxPrice=500&furnished=true&pets=true&availableFrom=2000-01-01T00:00:00.000Z"
CODE=$(curl -s -o "$WORK/search" -w '%{http_code}' "${BASE_URL}/api/rooms/search?${SEARCH_QUERY}")
assert_status "$CODE" 200 "room search"
grep -q "\"id\":${ROOM_ID}" "$WORK/search" || fail "room search returned the seeded room"
pass "room search returns the seeded room"

CODE=$(curl -s -o "$WORK/search-empty" -w '%{http_code}' "${BASE_URL}/api/rooms/search?minPrice=999999999")
assert_status "$CODE" 200 "room search with a non-matching bound"
[ "$(cat "$WORK/search-empty")" = "[]" ] || fail "room search with a non-matching bound returned results"
pass "room search with a non-matching bound is empty"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/rooms/search?furnished=yes")
assert_status "$CODE" 400 "room search rejects an invalid boolean"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/rooms/search?minSize=large")
assert_status "$CODE" 400 "room search rejects an invalid number"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/rooms/search?minPrice=-1")
assert_status "$CODE" 400 "room search rejects a negative bound"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/rooms/search?minPrice=1000&maxPrice=500")
assert_status "$CODE" 400 "room search rejects an inverted price range"

# 5c. the htmx search page and its results fragment
CODE=$(curl -s -o "$WORK/search-page" -w '%{http_code}' "${BASE_URL}/search")
assert_status "$CODE" 200 "search page"
grep -q 'hx-get="/search/results"' "$WORK/search-page" || fail "search page wires the form to the results fragment"
pass "search page wires the form to the results fragment"

CODE=$(curl -s -o "$WORK/search-fragment" -w '%{http_code}' \
  "${BASE_URL}/search/results?minPrice=500&maxPrice=500&availableFrom=2000-01-01")
assert_status "$CODE" 200 "search results fragment"
grep -q "${ROOM_LOCATION}" "$WORK/search-fragment" || fail "search fragment rendered the seeded room"
pass "search fragment rendered the seeded room"

# Empty form fields must not narrow the results: `""` decodes to 0 otherwise.
CODE=$(curl -s -o "$WORK/search-blank" -w '%{http_code}' \
  "${BASE_URL}/search/results?minPrice=&maxPrice=&minSize=&maxSize=&availableFrom=")
assert_status "$CODE" 200 "search fragment with blank fields"
grep -q "${ROOM_LOCATION}" "$WORK/search-blank" || fail "blank fields filtered rooms out"
pass "blank fields are treated as no filter"

CODE=$(curl -s -o "$WORK/search-invalid" -w '%{http_code}' "${BASE_URL}/search/results?minPrice=abc")
assert_status "$CODE" 200 "search fragment rejects an invalid filter in-band"
grep -q 'Those filters could not be read' "$WORK/search-invalid" || fail "invalid filter did not render the error"
pass "invalid filter renders the error"

# htmx swaps 2xx responses only, so the fragment reports an inverted range in
# the same swappable way instead of leaving the previous results on screen.
CODE=$(curl -s -o "$WORK/search-inverted" -w '%{http_code}' \
  "${BASE_URL}/search/results?minPrice=930003&maxPrice=910001")
assert_status "$CODE" 200 "search fragment rejects an inverted range in-band"
grep -q 'Those filters could not be read' "$WORK/search-inverted" || fail "inverted range did not render the error"
pass "inverted range renders the error"

# 6. refresh rotation via a route that does not re-read the access token
CODE=$(curl -s -D "$WORK/rotate.h" -o /dev/null -w '%{http_code}' "${BASE_URL}/private-get" \
  -H "Cookie: refresh_token=${REFRESH}")
assert_status "$CODE" 200 "refresh rotation request"
ROTATED_ACCESS="$(cookie_value "$WORK/rotate.h" access_token)"
ROTATED_REFRESH="$(cookie_value "$WORK/rotate.h" refresh_token)"
[ -n "$ROTATED_ACCESS" ] && [ -n "$ROTATED_REFRESH" ] || fail "refresh rotation set new cookies"
[ "$ROTATED_REFRESH" != "$REFRESH" ] || fail "refresh rotation did not rotate the token"
ROTATED_REFRESH_H=$(cookie_flags "$WORK/rotate.h" refresh_token)
printf '%s' "$ROTATED_REFRESH_H" | grep -qi 'httponly' || fail "rotated refresh_token missing HttpOnly"
printf '%s' "$ROTATED_REFRESH_H" | grep -qi 'secure'   || fail "rotated refresh_token missing Secure"
pass "refresh rotation issued new access + refresh cookies (refresh HttpOnly+Secure)"

# 7. multipart upload
printf 'hello estia multipart smoke test\n' > "$WORK/smoke.txt"
CODE=$(curl -s -o "$WORK/multipart" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/test-post" \
  -F "file=@$WORK/smoke.txt;type=text/plain")
assert_status "$CODE" 200 "multipart upload"
grep -q 'Successful' "$WORK/multipart" || fail "multipart upload response body"
pass "multipart upload response body"

echo "smoke checklist passed"
