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

# The account id an access token was minted for, so a check can name the row it
# expects the app to have read.
user_id_from_token() {
  # $1: access token
  node -e '
    const token = process.argv[1];
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    process.stdout.write(String(payload.id));
  ' "$1"
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
printf '%s' "$ACCESS_H" | grep -qi 'samesite=lax' || fail "access_token missing SameSite=Lax"
printf '%s' "$REFRESH_H" | grep -qi 'secure'  || fail "refresh_token missing Secure"
printf '%s' "$REFRESH_H" | grep -qi 'httponly' || fail "refresh_token missing HttpOnly"
printf '%s' "$REFRESH_H" | grep -qi 'samesite=lax' || fail "refresh_token missing SameSite=Lax"
pass "register cookie flags (both HttpOnly+Secure+SameSite=Lax)"

ACCESS="$(cookie_value "$WORK/register.h" access_token)"
REFRESH="$(cookie_value "$WORK/register.h" refresh_token)"
[ -n "$ACCESS" ] && [ -n "$REFRESH" ] || fail "register cookies present"

# 2b. the browser form paths
#
# The sign-in and register pages are plain forms, so a browser posts
# `application/x-www-form-urlencoded` to the page's own route. That route signs
# the person in and redirects to the feed, and a refused submit comes back with a
# readable page and an honest status. The JSON endpoints above keep working for
# API clients, including the duplicate-email 409 they used to answer with 500.
header_value() {
  # $1: header file, $2: header name
  { grep -i "^$2:" "$1" || true; } | head -1 | tr -d '\r' | cut -d' ' -f2-
}

CODE=$(curl -s -o "$WORK/login-page" -w '%{http_code}' "${BASE_URL}/login")
assert_status "$CODE" 200 "login page"
grep -q 'action="/login"' "$WORK/login-page" || fail "login page does not post to /login"
grep -q '>Sign in</button>' "$WORK/login-page" || fail "login page button is not labelled Sign in"
grep -q '</head>' "$WORK/login-page" || fail "login page has no closing head tag"
if grep -q '/api/auth/' "$WORK/login-page"; then fail "login page still posts into the JSON API"; fi
pass "login page posts its form to /login"

CODE=$(curl -s -o "$WORK/register-page" -w '%{http_code}' "${BASE_URL}/register")
assert_status "$CODE" 200 "register page"
grep -q 'action="/register"' "$WORK/register-page" || fail "register page does not post to /register"
grep -q 'name="repeat_password"' "$WORK/register-page" || fail "register page has no repeat-password box"
grep -q '>Create account</button>' "$WORK/register-page" || fail "register button is not labelled Create account"
grep -q '</head>' "$WORK/register-page" || fail "register page has no closing head tag"
pass "register page posts its form to /register"

FORM_EMAIL="smoke-form-$(date +%s)@test.local"
CODE=$(curl -s -D "$WORK/form-register.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/register" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "email=${FORM_EMAIL}" \
  --data-urlencode "password=${PASSWORD}" \
  --data-urlencode "repeat_password=${PASSWORD}")
assert_status "$CODE" 303 "form register"
FORM_LOCATION="$(header_value "$WORK/form-register.h" location)"
[ "$FORM_LOCATION" = "/search" ] \
  || fail "form register did not redirect to the feed (got ${FORM_LOCATION:-no Location header})"
pass "form register redirects to the feed"
FORM_ACCESS="$(cookie_value "$WORK/form-register.h" access_token)"
FORM_REFRESH="$(cookie_value "$WORK/form-register.h" refresh_token)"
[ -n "$FORM_ACCESS" ] && [ -n "$FORM_REFRESH" ] || fail "form register set the session cookies"
pass "form register sets the session cookies"

CODE=$(curl -s -o "$WORK/form-duplicate" -w '%{http_code}' \
  -X POST "${BASE_URL}/register" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "email=${FORM_EMAIL}" \
  --data-urlencode "password=${PASSWORD}" \
  --data-urlencode "repeat_password=${PASSWORD}")
assert_status "$CODE" 409 "form register rejects a duplicate email"
grep -q 'already exists' "$WORK/form-duplicate" \
  || fail "form register duplicate email has no readable message"
pass "form register duplicate email explains what to do"

CODE=$(curl -s -o "$WORK/json-duplicate" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${FORM_EMAIL}\",\"password\":\"${PASSWORD}\"}")
assert_status "$CODE" 409 "json register rejects a duplicate email"
grep -q 'UserAlreadyExistsError' "$WORK/json-duplicate" \
  || fail "json register duplicate email did not report UserAlreadyExistsError"
pass "json register duplicate email is a 409"

MISMATCH_EMAIL="smoke-mismatch-$(date +%s)@test.local"
CODE=$(curl -s -o "$WORK/form-mismatch" -w '%{http_code}' \
  -X POST "${BASE_URL}/register" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "email=${MISMATCH_EMAIL}" \
  --data-urlencode "password=${PASSWORD}" \
  --data-urlencode "repeat_password=${PASSWORD}!")
assert_status "$CODE" 400 "form register rejects a mismatched repeat password"
grep -q 'do not match' "$WORK/form-mismatch" \
  || fail "mismatched repeat password has no readable message"
pass "mismatched repeat password is explained"

CODE=$(curl -s -o "$WORK/form-login-bad" -w '%{http_code}' \
  -X POST "${BASE_URL}/login" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "email=${FORM_EMAIL}" \
  --data-urlencode 'password=not the password')
assert_status "$CODE" 401 "form login rejects a wrong password"
grep -q 'That email and password do not match' "$WORK/form-login-bad" \
  || fail "wrong password has no readable message"
pass "wrong password is explained"

CODE=$(curl -s -D "$WORK/form-login.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/login" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "email=${FORM_EMAIL}" \
  --data-urlencode "password=${PASSWORD}")
assert_status "$CODE" 303 "form login"
FORM_LOGIN_LOCATION="$(header_value "$WORK/form-login.h" location)"
[ "$FORM_LOGIN_LOCATION" = "/search" ] \
  || fail "form login did not redirect to the feed (got ${FORM_LOGIN_LOCATION:-no Location header})"
[ -n "$(cookie_value "$WORK/form-login.h" access_token)" ] \
  || fail "form login did not set the access cookie"
pass "form login redirects to the feed with a session"

CODE=$(curl -s -D "$WORK/form-login-origin.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/login" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "Origin: ${BASE_URL}" \
  --data-urlencode "email=${FORM_EMAIL}" \
  --data-urlencode "password=${PASSWORD}")
assert_status "$CODE" 303 "form login from the page's own origin"
[ -n "$(cookie_value "$WORK/form-login-origin.h" access_token)" ] \
  || fail "same-origin form login did not set the access cookie"
pass "form login from the page's own origin sets a session"

CODE=$(curl -s -D "$WORK/form-cross-site.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/login" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Origin: https://evil.example' \
  --data-urlencode "email=${FORM_EMAIL}" \
  --data-urlencode "password=${PASSWORD}")
assert_status "$CODE" 403 "form login rejects a cross-site submit"
[ -z "$(cookie_value "$WORK/form-cross-site.h" access_token)" ] \
  || fail "cross-site form login set a session cookie"
pass "cross-site form login sets no session"

# 3. unauthenticated rejection
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/users/me")
assert_status "$CODE" 401 "unauthenticated /api/users/me rejected"

# 3b. a freshly registered account has no profile row yet, and the profile call
# says so instead of failing: this is the state every new sign-up is in.
CODE=$(curl -s -o "$WORK/me-fresh" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "fresh user /api/users/me"
grep -q '"userProfile":null' "$WORK/me-fresh" \
  || fail "the fresh user's profile call did not report a null profile"
grep -q '"role":"user"' "$WORK/me-fresh" \
  || fail "the fresh user's profile call did not report the stored role"
pass "a fresh user's /api/users/me reports a null profile"

# 4. seed a profile for the fresh user, then current-user
USER_ID="$(user_id_from_token "$ACCESS")"
pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "INSERT OR IGNORE INTO seekers (user_id, name, bio, date_of_birth, gender, smoking, pets) VALUES ('${USER_ID}', 'Smoke User', NULL, 946684800000, 'NB', 1, 0);" \
  >/dev/null 2>&1 || fail "seed seeker profile"
pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "UPDATE users SET role='seeker' WHERE id='${USER_ID}';" \
  >/dev/null 2>&1 || fail "seed seeker role"
pass "seed seeker profile"

CODE=$(curl -s -o "$WORK/me" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "current-user /api/users/me"
grep -q '"userProfile"' "$WORK/me" || fail "current-user response has userProfile"
pass "current-user response shape"

# 5. the public listings feed and the htmx search page
#
# Seed two published listings in different regions plus one draft and one
# unpublished row. All four share one price so one filter selects the whole
# fixture set, and the draft/unpublished rows prove the published-only rule.
SMOKE_EUR=$(( ($(date +%s) % 90000) + 10000 ))
SMOKE_MINOR=$((SMOKE_EUR * 100))
NOW_MS=$(( $(date +%s) * 1000 ))
SMOKE_TAG="$(date +%s)-${SMOKE_EUR}"
CRETE_TITLE="Smoke crete listing ${SMOKE_TAG}"
EPIRUS_TITLE="Smoke epirus listing ${SMOKE_TAG}"
DRAFT_TITLE="Smoke draft listing ${SMOKE_TAG}"
UNPUBLISHED_TITLE="Smoke unpublished listing ${SMOKE_TAG}"

pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "INSERT INTO listings (kind, owner_id, status, title, description, price_minor, currency, region_code, size_sqm, available_from, furnished, ensuite, smoking, pets, created_at, updated_at, published_at) VALUES
    ('room', '${USER_ID}', 'published', '${CRETE_TITLE}', 'A published room in Crete', ${SMOKE_MINOR}, 'EUR', 'crete', 30, 946684800000, 1, 0, 0, 1, ${NOW_MS}, ${NOW_MS}, ${NOW_MS}),
    ('whole_property', '${USER_ID}', 'published', '${EPIRUS_TITLE}', 'A published property in Epirus', ${SMOKE_MINOR}, 'EUR', 'epirus', 90, NULL, 0, 0, 0, 0, $((NOW_MS + 1000)), $((NOW_MS + 1000)), $((NOW_MS + 1000))),
    ('room', '${USER_ID}', 'draft', '${DRAFT_TITLE}', NULL, ${SMOKE_MINOR}, 'EUR', 'crete', 30, NULL, 0, 0, 0, 0, $((NOW_MS + 2000)), $((NOW_MS + 2000)), NULL),
    ('room', '${USER_ID}', 'unpublished', '${UNPUBLISHED_TITLE}', NULL, ${SMOKE_MINOR}, 'EUR', 'crete', 30, NULL, 0, 0, 0, 0, $((NOW_MS + 3000)), $((NOW_MS + 3000)), $((NOW_MS + 3000)));" \
  >/dev/null 2>&1 || fail "seed listings"
pass "seed listings"

listing_id() {
  # $1: unique title
  pnpm exec wrangler d1 execute "$DB_BINDING" --local --json \
    --command "SELECT id FROM listings WHERE title='$1' ORDER BY id DESC LIMIT 1;" 2>/dev/null \
    | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s)[0].results[0].id)))'
}

CRETE_ID="$(listing_id "$CRETE_TITLE")"
EPIRUS_ID="$(listing_id "$EPIRUS_TITLE")"
DRAFT_ID="$(listing_id "$DRAFT_TITLE")"
UNPUBLISHED_ID="$(listing_id "$UNPUBLISHED_TITLE")"
[ -n "$CRETE_ID" ] && [ -n "$EPIRUS_ID" ] && [ -n "$DRAFT_ID" ] && [ -n "$UNPUBLISHED_ID" ] \
  || fail "listing ids"
pass "listing ids"

listing_ids() {
  node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const body = JSON.parse(s); process.stdout.write(body.items.map((item) => item.id).join(",")); })'
}

PRICE_QUERY="minPriceMinor=${SMOKE_MINOR}&maxPriceMinor=${SMOKE_MINOR}"

CODE=$(curl -s -o "$WORK/listings" -w '%{http_code}' "${BASE_URL}/api/listings?${PRICE_QUERY}")
assert_status "$CODE" 200 "listings search"
LISTING_IDS="$(listing_ids < "$WORK/listings")"
case ",${LISTING_IDS}," in
  *",${EPIRUS_ID},"*) ;;
  *) fail "listings search did not return the epirus row (got ${LISTING_IDS})" ;;
esac
case ",${LISTING_IDS}," in
  *",${CRETE_ID},"*) ;;
  *) fail "listings search did not return the crete row (got ${LISTING_IDS})" ;;
esac
[ "${LISTING_IDS%%,*}" = "${EPIRUS_ID}" ] \
  || fail "listings search is not newest first (got ${LISTING_IDS})"
pass "listings search returns published rows newest first"
case ",${LISTING_IDS}," in
  *",${DRAFT_ID},"*|*",${UNPUBLISHED_ID},"*) fail "listings search returned an unpublished row" ;;
  *) pass "listings search excludes draft and unpublished rows" ;;
esac

CODE=$(curl -s -o "$WORK/listings-crete" -w '%{http_code}' \
  "${BASE_URL}/api/listings?${PRICE_QUERY}&regionCode=crete")
assert_status "$CODE" 200 "listings search with a region filter"
CRETE_IDS="$(listing_ids < "$WORK/listings-crete")"
case ",${CRETE_IDS}," in
  *",${CRETE_ID},"*) ;;
  *) fail "region filter did not include crete (got ${CRETE_IDS})" ;;
esac
case ",${CRETE_IDS}," in
  *",${EPIRUS_ID},"*) fail "region filter did not narrow to crete (got ${CRETE_IDS})" ;;
esac
pass "region filter narrows to crete"

CODE=$(curl -s -o "$WORK/listings-epirus" -w '%{http_code}' \
  "${BASE_URL}/api/listings?${PRICE_QUERY}&regionCode=epirus")
assert_status "$CODE" 200 "listings search with another region filter"
EPIRUS_IDS="$(listing_ids < "$WORK/listings-epirus")"
case ",${EPIRUS_IDS}," in
  *",${EPIRUS_ID},"*) ;;
  *) fail "region filter did not include epirus (got ${EPIRUS_IDS})" ;;
esac
case ",${EPIRUS_IDS}," in
  *",${CRETE_ID},"*) fail "region filter did not narrow to epirus (got ${EPIRUS_IDS})" ;;
esac
pass "region filter narrows to epirus"

CODE=$(curl -s -o "$WORK/listings-page1" -w '%{http_code}' \
  "${BASE_URL}/api/listings?${PRICE_QUERY}&limit=1")
assert_status "$CODE" 200 "listings search with a limit"
FIRST_PAGE="$(listing_ids < "$WORK/listings-page1")"
CURSOR="$(node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const body = JSON.parse(s); process.stdout.write(body.nextCursor == null ? "" : String(body.nextCursor)); })' < "$WORK/listings-page1")"
[ "$FIRST_PAGE" = "${EPIRUS_ID}" ] || fail "limit was not respected (got ${FIRST_PAGE})"
[ -n "$CURSOR" ] || fail "limit did not return a nextCursor"
case "$CURSOR" in
  *:*|*[+/=]*) fail "cursor is not base64url: ${CURSOR}" ;;
  *) pass "limit is respected and returns a base64url nextCursor" ;;
esac

CODE=$(curl -s -o "$WORK/listings-page2" -w '%{http_code}' \
  "${BASE_URL}/api/listings?${PRICE_QUERY}&limit=1&cursor=${CURSOR}")
assert_status "$CODE" 200 "listings search second page"
SECOND_PAGE="$(listing_ids < "$WORK/listings-page2")"
[ -n "$SECOND_PAGE" ] || fail "second page is empty"
[ "$SECOND_PAGE" != "$FIRST_PAGE" ] || fail "second page repeated the first page"
pass "second page is non-empty and disjoint from the first"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings?cursor=not-a-cursor")
assert_status "$CODE" 400 "listings search rejects a malformed cursor"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings?limit=51")
assert_status "$CODE" 400 "listings search rejects a limit above the cap"

# 5b. the htmx search page and its results fragment
CODE=$(curl -s -o "$WORK/search-page" -w '%{http_code}' "${BASE_URL}/search")
assert_status "$CODE" 200 "search page"
grep -q 'hx-get="/search/results"' "$WORK/search-page" || fail "search page wires the form to the results fragment"
pass "search page wires the form to the results fragment"
grep -q 'name="regionCode"' "$WORK/search-page" || fail "search page has a region filter"
grep -q '>Attica<' "$WORK/search-page" || fail "search page region options use human labels"
pass "search page has a region filter with human labels"
grep -q 'name="kind"' "$WORK/search-page" || fail "search page has a kind filter"
grep -q '>Whole property<' "$WORK/search-page" || fail "search page kind options use human labels"
pass "search page has a kind filter with human labels"

FRAGMENT_QUERY="minPrice=${SMOKE_EUR}&maxPrice=${SMOKE_EUR}"
CODE=$(curl -s -o "$WORK/search-fragment" -w '%{http_code}' \
  "${BASE_URL}/search/results?${FRAGMENT_QUERY}")
assert_status "$CODE" 200 "search results fragment"
grep -q "${CRETE_TITLE}" "$WORK/search-fragment" || fail "search fragment rendered the crete listing"
grep -q "${EPIRUS_TITLE}" "$WORK/search-fragment" || fail "search fragment rendered the epirus listing"
grep -q "Crete" "$WORK/search-fragment" || fail "search fragment rendered the region label"
pass "search fragment rendered the seeded listings"

# A result is a door: the whole card links to the listing's public page.
grep -q "href=\"/listings/${CRETE_ID}\"" "$WORK/search-fragment" \
  || fail "search results do not link to the detail page"
pass "search result cards link to the detail page"

CODE=$(curl -s -o "$WORK/search-region" -w '%{http_code}' \
  "${BASE_URL}/search/results?${FRAGMENT_QUERY}&regionCode=crete")
assert_status "$CODE" 200 "search fragment with a region filter"
grep -q "${CRETE_TITLE}" "$WORK/search-region" || fail "region filter dropped the crete listing"
if grep -q "${EPIRUS_TITLE}" "$WORK/search-region"; then
  fail "region filter did not narrow the fragment"
fi
pass "search fragment narrows by region"

CODE=$(curl -s -o "$WORK/search-next" -w '%{http_code}' \
  "${BASE_URL}/search/results?${FRAGMENT_QUERY}&limit=1")
assert_status "$CODE" 200 "search fragment with a limit"
grep -q 'Next page' "$WORK/search-next" || fail "search fragment did not offer a next page"
pass "search fragment offers a next page when more results exist"

# Empty form fields must not narrow the results: the fragment drops them
# before decoding, since a blank numeric bound is not a valid filter.
CODE=$(curl -s -o "$WORK/search-blank" -w '%{http_code}' \
  "${BASE_URL}/search/results?${FRAGMENT_QUERY}&minSizeSqm=&maxSizeSqm=&availableFrom=&regionCode=&kind=")
assert_status "$CODE" 200 "search fragment with blank fields"
grep -q "${CRETE_TITLE}" "$WORK/search-blank" || fail "blank fields filtered listings out"
pass "blank fields are treated as no filter"

CODE=$(curl -s -o "$WORK/search-invalid" -w '%{http_code}' "${BASE_URL}/search/results?minPrice=abc")
assert_status "$CODE" 200 "search fragment invalid filter returns 200"
grep -q 'Those filters could not be read' "$WORK/search-invalid" || fail "search fragment did not report the invalid filter"
pass "search fragment reports an invalid filter"

CODE=$(curl -s -o "$WORK/search-inverted" -w '%{http_code}' \
  "${BASE_URL}/search/results?minPrice=2000&maxPrice=500")
assert_status "$CODE" 200 "search fragment inverted range returns 200"
grep -q 'Those filters could not be read' "$WORK/search-inverted" || fail "search fragment did not report the inverted range"
pass "search fragment reports an inverted range"

CODE=$(curl -s -o "$WORK/search-cursor" -w '%{http_code}' "${BASE_URL}/search/results?cursor=not-a-cursor")
assert_status "$CODE" 200 "search fragment malformed cursor returns 200"
grep -q 'Those filters could not be read' "$WORK/search-cursor" || fail "search fragment did not report the malformed cursor"
pass "search fragment reports a malformed cursor"

# 5c. the authenticated listing lifecycle through the API:
#
# create a draft, correct it, publish it, find it in the public feed, then unlist
# it and confirm it disappears again. The title and price are unique to this run so
# the public-feed checks can only match this listing.
json_field() {
  # $1: field name, stdin: JSON body
  node -e 'let s=""; process.stdin.on("data", (d) => s += d).on("end", () => { const value = JSON.parse(s)[process.argv[1]]; process.stdout.write(value == null ? "" : String(value)); })' "$1"
}

API_EUR=$(( ($(date +%s) % 9000) + 31000 ))
API_MINOR=$((API_EUR * 100))
API_TITLE="Smoke API draft ${SMOKE_TAG}"
API_EDITED_TITLE="Smoke API draft ${SMOKE_TAG} edited"
API_QUERY="minPriceMinor=${API_MINOR}&maxPriceMinor=${API_MINOR}"

CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/listings" \
  -H 'Content-Type: application/json' \
  -d "{\"kind\":\"room\",\"title\":\"${API_TITLE}\",\"priceMinor\":${API_MINOR},\"regionCode\":\"crete\"}")
assert_status "$CODE" 401 "api listing create rejects an unauthenticated caller"

CODE=$(curl -s -o "$WORK/api-create" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/listings" \
  -H 'Content-Type: application/json' \
  -H "Cookie: access_token=${ACCESS}" \
  -d "{\"kind\":\"room\",\"title\":\"${API_TITLE}\",\"description\":\"Created through the API\",\"priceMinor\":${API_MINOR},\"regionCode\":\"crete\",\"sizeSqm\":25,\"furnished\":1,\"ensuite\":0,\"smoking\":0,\"pets\":1}")
assert_status "$CODE" 200 "api listing create"
API_ID="$(json_field id < "$WORK/api-create")"
[ -n "$API_ID" ] || fail "api listing create returned an id"
[ "$(json_field status < "$WORK/api-create")" = "draft" ] || fail "api listing create did not create a draft"
pass "api listing create returns a draft"

CODE=$(curl -s -o "$WORK/api-feed-draft" -w '%{http_code}' "${BASE_URL}/api/listings?${API_QUERY}")
assert_status "$CODE" 200 "api feed before publish"
case ",$(listing_ids < "$WORK/api-feed-draft")," in
  *",${API_ID},"*) fail "a draft reached the public feed" ;;
  *) pass "a draft is not in the public feed" ;;
esac
CODE=$(curl -s -o "$WORK/api-update" -w '%{http_code}' \
  -X PATCH "${BASE_URL}/api/listings/${API_ID}" \
  -H 'Content-Type: application/json' \
  -H "Cookie: access_token=${ACCESS}" \
  -d "{\"title\":\"${API_EDITED_TITLE}\",\"sizeSqm\":30}")
assert_status "$CODE" 200 "api listing update"
[ "$(json_field title < "$WORK/api-update")" = "${API_EDITED_TITLE}" ] || fail "api listing update did not change the title"
[ "$(json_field sizeSqm < "$WORK/api-update")" = "30" ] || fail "api listing update did not change the size"
pass "api listing update changes the listing"

CODE=$(curl -s -o "$WORK/api-publish" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/listings/${API_ID}/publish" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "api listing publish"
[ "$(json_field status < "$WORK/api-publish")" = "published" ] || fail "api listing publish did not publish"
pass "api listing publish returns a published listing"

CODE=$(curl -s -o "$WORK/api-feed-published" -w '%{http_code}' "${BASE_URL}/api/listings?${API_QUERY}")
assert_status "$CODE" 200 "api feed after publish"
case ",$(listing_ids < "$WORK/api-feed-published")," in
  *",${API_ID},"*) pass "the published listing is in the public feed" ;;
  *) fail "the published listing is missing from the public feed" ;;
esac
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/listings/${API_ID}/publish" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 409 "api listing publish rejects republishing"

# 5d. the public read surface: a published listing opens through the API and
# the page, with only the public fields on the wire. The same 404 answers for a
# draft, an unlisted listing, and an unknown id, so ids cannot be probed.
CODE=$(curl -s -o "$WORK/api-detail" -w '%{http_code}' \
  "${BASE_URL}/api/listings/${API_ID}")
assert_status "$CODE" 200 "public listing detail API"
[ "$(json_field id < "$WORK/api-detail")" = "${API_ID}" ] \
  || fail "public listing detail returned the wrong id"
[ "$(json_field title < "$WORK/api-detail")" = "${API_EDITED_TITLE}" ] \
  || fail "public listing detail returned the wrong title"
for KEY in ownerId status lat lng createdAt updatedAt; do
  if grep -q "\"${KEY}\"" "$WORK/api-detail"; then
    fail "public listing detail exposed ${KEY}"
  fi
done
pass "public listing detail returns only the public fields"

CODE=$(curl -s -o "$WORK/api-detail-draft" -w '%{http_code}' \
  "${BASE_URL}/api/listings/${DRAFT_ID}")
assert_status "$CODE" 404 "public listing detail hides a draft"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/${UNPUBLISHED_ID}")
assert_status "$CODE" 404 "public listing detail hides an unlisted listing"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/999999999")
assert_status "$CODE" 404 "public listing detail hides an unknown id"

CODE=$(curl -s -o "$WORK/detail-page" -w '%{http_code}' "${BASE_URL}/listings/${API_ID}")
assert_status "$CODE" 200 "public listing detail page"
grep -q "${API_EDITED_TITLE}" "$WORK/detail-page" || fail "detail page did not render the title"
grep -q 'Crete' "$WORK/detail-page" || fail "detail page did not render the region"
grep -q '<title>' "$WORK/detail-page" || fail "detail page has no title metadata"
grep -q 'name="description"' "$WORK/detail-page" || fail "detail page has no description metadata"
grep -q 'href="/search"' "$WORK/detail-page" || fail "detail page has no back-to-search link"
pass "public listing detail page renders the listing with metadata and a way back"

CODE=$(curl -s -o "$WORK/detail-page-draft" -w '%{http_code}' "${BASE_URL}/listings/${DRAFT_ID}")
assert_status "$CODE" 404 "public listing detail page hides a draft"
grep -q 'Listing not found' "$WORK/detail-page-draft" \
  || fail "detail page did not render the not-found state"
grep -q 'href="/search"' "$WORK/detail-page-draft" \
  || fail "not-found page has no way back to search"
pass "draft detail page shows the not-found state with a way back"

CODE=$(curl -s -o "$WORK/api-unlist" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/listings/${API_ID}/unlist" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "api listing unlist"
[ "$(json_field status < "$WORK/api-unlist")" = "unpublished" ] || fail "api listing unlist did not unlist"
pass "api listing unlist returns an unlisted listing"

CODE=$(curl -s -o "$WORK/api-feed-unlisted" -w '%{http_code}' "${BASE_URL}/api/listings?${API_QUERY}")
assert_status "$CODE" 200 "api feed after unlist"
case ",$(listing_ids < "$WORK/api-feed-unlisted")," in
  *",${API_ID},"*) fail "an unlisted listing stayed in the public feed" ;;
  *) pass "an unlisted listing is gone from the public feed" ;;
esac

# The same listing that opened a moment ago is now a 404 on both surfaces, and
# its page shows the not-found state instead of a stack trace or a blank body.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/${API_ID}")
assert_status "$CODE" 404 "public listing detail is 404 once unlisted"

CODE=$(curl -s -o "$WORK/detail-page-unlisted" -w '%{http_code}' "${BASE_URL}/listings/${API_ID}")
assert_status "$CODE" 404 "public listing detail page is 404 once unlisted"
grep -q 'Listing not found' "$WORK/detail-page-unlisted" \
  || fail "unlisted detail page did not render the not-found state"
grep -q 'href="/search"' "$WORK/detail-page-unlisted" \
  || fail "unlisted not-found page has no way back to search"
pass "unlisted detail page shows the not-found state with a way back"

# 5e. the owner's own feed (GET /api/listings/mine and /listings/mine)
#
# Two independent users, each posting a fresh draft: every "mine" feed contains
# only its own rows - drafts included - while the public feed still hides those
# drafts. Publishing from the page itself is exercised end to end.
SECOND_EMAIL="smoke-second-$(date +%s)@test.local"
CODE=$(curl -s -D "$WORK/register-second.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${SECOND_EMAIL}\",\"password\":\"${PASSWORD}\"}")
assert_status "$CODE" 200 "register second smoke user"
SECOND_ACCESS="$(cookie_value "$WORK/register-second.h" access_token)"
[ -n "$SECOND_ACCESS" ] || fail "second smoke user has no access cookie"
pass "second smoke user registered"

MINE_EUR=$(( ($(date +%s) % 3000) + 81000 ))
MINE_MINOR=$((MINE_EUR * 100))
MINE_TITLE="Smoke mine draft ${SMOKE_TAG}"
MINE_TITLE_2="Smoke mine draft two ${SMOKE_TAG}"
SECOND_TITLE="Smoke second user draft ${SMOKE_TAG}"

post_listing() {
  # $1: access cookie, $2: title, $3: minor price, $4: response body file
  curl -s -o "$4" -w '%{http_code}' \
    -X POST "${BASE_URL}/api/listings" \
    -H 'Content-Type: application/json' \
    -H "Cookie: access_token=$1" \
    -d "{\"kind\":\"room\",\"title\":\"$2\",\"priceMinor\":$3,\"regionCode\":\"crete\"}"
}

CODE=$(post_listing "$ACCESS" "$MINE_TITLE" "$MINE_MINOR" "$WORK/mine-create")
assert_status "$CODE" 200 "mine listing create"
MINE_ID="$(json_field id < "$WORK/mine-create")"
CODE=$(post_listing "$ACCESS" "$MINE_TITLE_2" "$MINE_MINOR" "$WORK/mine-create-2")
assert_status "$CODE" 200 "mine listing create (second)"
MINE_ID_2="$(json_field id < "$WORK/mine-create-2")"
CODE=$(post_listing "$SECOND_ACCESS" "$SECOND_TITLE" "$MINE_MINOR" "$WORK/mine-create-second")
assert_status "$CODE" 200 "second user's listing create"
SECOND_ID="$(json_field id < "$WORK/mine-create-second")"
[ -n "$MINE_ID" ] && [ -n "$MINE_ID_2" ] && [ -n "$SECOND_ID" ] || fail "mine listing ids"
pass "two users each posted a draft"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/mine")
assert_status "$CODE" 401 "the mine feed rejects an unauthenticated caller"
CODE=$(curl -s -o "$WORK/mine-unauth" -w '%{http_code}' "${BASE_URL}/listings/mine")
assert_status "$CODE" 401 "the mine page rejects an unauthenticated caller"
grep -q "You need to be signed in to see your listings and manage them." "$WORK/mine-unauth" \
  || fail "the signed-out mine page did not render the sign-in prompt"
if grep -q 'UnauthorizedError' "$WORK/mine-unauth"; then
  fail "the signed-out mine page answered with a bare 401 body"
fi
pass "the signed-out mine page renders the sign-in prompt"

id_before() {
  # $1: id expected earlier, $2: id expected later, stdin: mine feed JSON
  node -e 'let s=""; process.stdin.on("data", (d) => s += d).on("end", () => { const items = JSON.parse(s).items.map((item) => String(item.id)); const a = items.indexOf(process.argv[1]); const b = items.indexOf(process.argv[2]); process.exit(a >= 0 && b >= 0 && a < b ? 0 : 1); })' "$1" "$2"
}

listing_status() {
  # $1: listing id, stdin: mine feed JSON
  node -e 'let s=""; process.stdin.on("data", (d) => s += d).on("end", () => { const found = JSON.parse(s).items.find((item) => String(item.id) === process.argv[1]); process.stdout.write(found === undefined ? "" : String(found.status)); })' "$1"
}

CODE=$(curl -s -o "$WORK/mine-feed" -w '%{http_code}' "${BASE_URL}/api/listings/mine?limit=50" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "mine feed"
MINE_IDS="$(listing_ids < "$WORK/mine-feed")"
for id in "$MINE_ID" "$MINE_ID_2" "$API_ID" "$DRAFT_ID"; do
  case ",${MINE_IDS}," in
    *",${id},"*) ;;
    *) fail "mine feed is missing the owner's listing ${id} (got ${MINE_IDS})" ;;
  esac
done
pass "mine feed includes the owner's drafts and unlisted listings"
case ",${MINE_IDS}," in
  *",${SECOND_ID},"*) fail "mine feed leaked another user's listing" ;;
  *) pass "mine feed never returns another user's rows" ;;
esac
id_before "$MINE_ID_2" "$MINE_ID" < "$WORK/mine-feed" \
  || fail "mine feed is not newest first (got ${MINE_IDS})"
pass "mine feed is newest first"

CODE=$(curl -s -o "$WORK/mine-feed-second" -w '%{http_code}' "${BASE_URL}/api/listings/mine?limit=50" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "second user's mine feed"
SECOND_IDS="$(listing_ids < "$WORK/mine-feed-second")"
case ",${SECOND_IDS}," in
  *",${SECOND_ID},"*) pass "second user's mine feed includes its own draft" ;;
  *) fail "second user's mine feed is missing its own draft (got ${SECOND_IDS})" ;;
esac
case ",${SECOND_IDS}," in
  *",${MINE_ID},"*|*",${MINE_ID_2},"*) fail "second user's mine feed leaked another user's rows" ;;
  *) pass "second user's mine feed only has its own rows" ;;
esac

CODE=$(curl -s -o "$WORK/mine-page1" -w '%{http_code}' "${BASE_URL}/api/listings/mine?limit=1" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "mine feed with a limit"
MINE_CURSOR=$(node -e 'let s=""; process.stdin.on("data", (d) => s += d).on("end", () => { const body = JSON.parse(s); process.stdout.write(body.nextCursor == null ? "" : String(body.nextCursor)); })' < "$WORK/mine-page1")
[ -n "$MINE_CURSOR" ] || fail "mine feed did not return a nextCursor"
CODE=$(curl -s -o "$WORK/mine-page2" -w '%{http_code}' \
  "${BASE_URL}/api/listings/mine?limit=1&cursor=${MINE_CURSOR}" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "mine feed second page"
MINE_PAGE1_ID="$(listing_ids < "$WORK/mine-page1")"
MINE_PAGE2_ID="$(listing_ids < "$WORK/mine-page2")"
[ -n "$MINE_PAGE2_ID" ] || fail "mine feed second page is empty"
[ "$MINE_PAGE2_ID" != "$MINE_PAGE1_ID" ] || fail "mine feed second page repeated the first page"
pass "mine feed pages with its cursor"

# The fresh drafts are not in the public feed, so the mine feed genuinely shows
# rows a visitor cannot reach.
CODE=$(curl -s -o "$WORK/mine-public" -w '%{http_code}' \
  "${BASE_URL}/api/listings?minPriceMinor=${MINE_MINOR}&maxPriceMinor=${MINE_MINOR}")
assert_status "$CODE" 200 "public feed for the mine fixture price"
PUBLIC_IDS="$(listing_ids < "$WORK/mine-public")"
case ",${PUBLIC_IDS}," in
  *",${MINE_ID},"*|*",${MINE_ID_2},"*|*",${SECOND_ID},"*) fail "a draft reached the public feed" ;;
  *) pass "the mine feed's drafts are not in the public feed" ;;
esac

# The page itself: drafts render with a status badge and a publish action that
# comes back to this page.
CODE=$(curl -s -o "$WORK/mine-page" -w '%{http_code}' "${BASE_URL}/listings/mine" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "mine page"
grep -q "${MINE_TITLE_2}" "$WORK/mine-page" || fail "mine page rendered the owner's listing"
grep -q 'Draft' "$WORK/mine-page" || fail "mine page shows a status badge"
grep -Eq 'Showing [0-9]+ listings?, newest first' "$WORK/mine-page" \
  || fail "mine page did not render the owner's feed count"
grep -q "action=\"/listings/${MINE_ID}/publish\"" "$WORK/mine-page" || fail "mine page offers publish on a draft"
grep -q 'name="returnTo" value="/listings/mine"' "$WORK/mine-page" || fail "mine page actions name the page to return to"
pass "mine page renders drafts with a status badge and a publish action"

# Another site can post these forms without a preflight, so the routes refuse a
# foreign Origin themselves and the listing must not move. The cookies say
# SameSite=Lax as well, which keeps the session off such a post in the first place.
CROSS_TITLE="Smoke cross-site create ${SMOKE_TAG}"
CODE=$(curl -s -o "$WORK/cross-site-create" -w '%{http_code}' \
  -X POST "${BASE_URL}/listings/new" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Origin: https://evil.example' \
  -H "Cookie: access_token=${ACCESS}" \
  --data-urlencode 'kind=room' \
  --data-urlencode "title=${CROSS_TITLE}" \
  --data-urlencode 'price=1234' \
  --data-urlencode 'regionCode=crete')
assert_status "$CODE" 403 "creating a listing from another site is refused"
grep -q 'can only be submitted from this site' "$WORK/cross-site-create" \
  || fail "the refused cross-site create has no readable message"
pass "a cross-site create is refused with a readable reason"

CODE=$(curl -s -o "$WORK/cross-site-publish" -w '%{http_code}' \
  -X POST "${BASE_URL}/listings/${MINE_ID}/publish" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Origin: https://evil.example' \
  -H "Cookie: access_token=${ACCESS}" \
  --data-urlencode "returnTo=/listings/mine")
assert_status "$CODE" 403 "publishing from another site is refused"

# The same transition is a payload-less post on the JSON API, which a page on
# another site can submit as a plain form post, so the API refuses a foreign
# origin itself instead of relying on the cookie attribute.
CODE=$(curl -s -o "$WORK/api-cross-site-publish" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/listings/${MINE_ID}/publish" \
  -H 'Origin: https://evil.example' \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 403 "the API refuses a publish from another site"

CODE=$(curl -s -o "$WORK/mine-after-cross-site" -w '%{http_code}' \
  "${BASE_URL}/api/listings/mine?limit=50" -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "mine feed after the refused cross-site posts"
[ "$(listing_status "$MINE_ID" < "$WORK/mine-after-cross-site")" = "draft" ] \
  || fail "a cross-site publish changed the listing"
if grep -q "${CROSS_TITLE}" "$WORK/mine-after-cross-site"; then
  fail "a cross-site create created a listing"
fi
pass "refused cross-site posts change nothing"

# The same publish the page itself makes, from the page's own origin.
CODE=$(curl -s -D "$WORK/mine-publish.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/listings/${MINE_ID}/publish" \
  -H "Cookie: access_token=${ACCESS}" \
  -H "Origin: ${BASE_URL}" \
  --data-urlencode "returnTo=/listings/mine")
assert_status "$CODE" 303 "publish from the mine page"
MINE_LOCATION=$(grep -i '^location:' "$WORK/mine-publish.h" | head -1 | tr -d '\r' | sed -E 's/^[Ll]ocation: //')
[ "$MINE_LOCATION" = "/listings/mine" ] \
  || fail "publish did not return to the mine page (got ${MINE_LOCATION})"
pass "publish from the mine page returns to the mine page"

CODE=$(curl -s -o "$WORK/mine-after-publish" -w '%{http_code}' "${BASE_URL}/api/listings/mine?limit=50" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "mine feed after publishing"
[ "$(listing_status "$MINE_ID" < "$WORK/mine-after-publish")" = "published" ] \
  || fail "publishing from the mine page did not publish the listing"
pass "publishing from the mine page changes the status"

# A second publish is illegal, and the rejection has to be readable on the page
# the owner came from instead of an empty response.
CODE=$(curl -s -o "$WORK/mine-rejected" -w '%{http_code}' \
  -X POST "${BASE_URL}/listings/${MINE_ID}/publish" \
  -H "Cookie: access_token=${ACCESS}" \
  --data-urlencode "returnTo=/listings/mine")
assert_status "$CODE" 409 "publishing twice from the mine page is rejected"
grep -q "This listing is already published." "$WORK/mine-rejected" \
  || fail "the mine page did not explain the rejected transition"
grep -q "${MINE_TITLE_2}" "$WORK/mine-rejected" \
  || fail "the rejection did not re-render the owner's feed"
grep -Eq 'Showing [0-9]+ listings?, newest first' "$WORK/mine-rejected" \
  || fail "the rejection did not re-render the owner's feed count"
pass "a rejected transition is explained on the mine page"

# 5f. the listings map
#
# Three published pins - two sharing one ~1 km grid cell in Athens and one in
# Crete - plus every state that must never reach the map: a draft with a
# coordinate, a published listing without one, and a published room-wanted ad.
MAP_EUR=$(( ($(date +%s) % 4000) + 45000 ))
MAP_MINOR=$((MAP_EUR * 100))
MAP_ATHENS_A="Smoke map athens a ${SMOKE_TAG}"
MAP_ATHENS_B="Smoke map athens b ${SMOKE_TAG}"
MAP_CRETE="Smoke map crete ${SMOKE_TAG}"
MAP_DRAFT="Smoke map draft ${SMOKE_TAG}"
MAP_BARE="Smoke map bare ${SMOKE_TAG}"
MAP_WANTED="Smoke map wanted ${SMOKE_TAG}"

pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "INSERT INTO listings (kind, owner_id, status, title, description, price_minor, currency, region_code, lat, lng, size_sqm, available_from, furnished, ensuite, smoking, pets, created_at, updated_at, published_at) VALUES
    ('room', '${USER_ID}', 'published', '${MAP_ATHENS_A}', NULL, ${MAP_MINOR}, 'EUR', 'attica', 37.9838, 23.7275, 30, NULL, 1, 0, 0, 0, $((NOW_MS + 4000)), $((NOW_MS + 4000)), $((NOW_MS + 4000))),
    ('whole_property', '${USER_ID}', 'published', '${MAP_ATHENS_B}', NULL, ${MAP_MINOR}, 'EUR', 'attica', 37.9812, 23.7291, 90, NULL, 0, 0, 0, 1, $((NOW_MS + 5000)), $((NOW_MS + 5000)), $((NOW_MS + 5000))),
    ('room', '${USER_ID}', 'published', '${MAP_CRETE}', NULL, ${MAP_MINOR}, 'EUR', 'crete', 35.2401, 25.7219, 45, NULL, 0, 0, 0, 0, $((NOW_MS + 6000)), $((NOW_MS + 6000)), $((NOW_MS + 6000))),
    ('room', '${USER_ID}', 'draft', '${MAP_DRAFT}', NULL, ${MAP_MINOR}, 'EUR', 'attica', 37.98, 23.73, 30, NULL, 0, 0, 0, 0, $((NOW_MS + 7000)), $((NOW_MS + 7000)), NULL),
    ('room', '${USER_ID}', 'published', '${MAP_BARE}', NULL, ${MAP_MINOR}, 'EUR', 'attica', NULL, NULL, 30, NULL, 0, 0, 0, 0, $((NOW_MS + 8000)), $((NOW_MS + 8000)), $((NOW_MS + 8000))),
    ('room_wanted', '${USER_ID}', 'published', '${MAP_WANTED}', NULL, ${MAP_MINOR}, 'EUR', 'attica', 37.98, 23.73, NULL, NULL, 0, 0, 0, 0, $((NOW_MS + 9000)), $((NOW_MS + 9000)), $((NOW_MS + 9000)));" \
  >/dev/null 2>&1 || fail "seed map listings"
pass "seed map listings"

MAP_A_ID="$(listing_id "$MAP_ATHENS_A")"
MAP_B_ID="$(listing_id "$MAP_ATHENS_B")"
MAP_C_ID="$(listing_id "$MAP_CRETE")"
MAP_DRAFT_ID="$(listing_id "$MAP_DRAFT")"
MAP_BARE_ID="$(listing_id "$MAP_BARE")"
MAP_WANTED_ID="$(listing_id "$MAP_WANTED")"
[ -n "$MAP_A_ID" ] && [ -n "$MAP_B_ID" ] && [ -n "$MAP_C_ID" ] && [ -n "$MAP_DRAFT_ID" ] \
  && [ -n "$MAP_BARE_ID" ] && [ -n "$MAP_WANTED_ID" ] || fail "map listing ids"
pass "map listing ids"

pin_ids() {
  node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const body = JSON.parse(s); process.stdout.write(body.pins.map((pin) => pin.id).join(",")); })'
}

pin_field() {
  # $1: pin id, $2: field name, stdin: map response JSON
  node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const body = JSON.parse(s); const pin = body.pins.find((item) => String(item.id) === process.argv[1]); process.stdout.write(pin === undefined || pin[process.argv[2]] == null ? "" : String(pin[process.argv[2]])); })' "$1" "$2"
}

MAP_QUERY="minPriceMinor=${MAP_MINOR}&maxPriceMinor=${MAP_MINOR}"

CODE=$(curl -s -o "$WORK/map-pins" -w '%{http_code}' "${BASE_URL}/api/listings/map?${MAP_QUERY}")
assert_status "$CODE" 200 "listings map endpoint"
MAP_IDS="$(pin_ids < "$WORK/map-pins")"
for id in "$MAP_A_ID" "$MAP_B_ID" "$MAP_C_ID"; do
  case ",${MAP_IDS}," in
    *",${id},"*) ;;
    *) fail "listings map is missing published pin ${id} (got ${MAP_IDS})" ;;
  esac
done
pass "listings map returns the published pins"
case ",${MAP_IDS}," in
  *",${MAP_DRAFT_ID},"*) fail "listings map returned a draft" ;;
  *) pass "listings map excludes drafts" ;;
esac
case ",${MAP_IDS}," in
  *",${MAP_BARE_ID},"*) fail "listings map returned a listing without a coordinate" ;;
  *) pass "listings map requires a coordinate" ;;
esac
case ",${MAP_IDS}," in
  *",${MAP_WANTED_ID},"*) fail "listings map returned a room-wanted ad" ;;
  *) pass "listings map excludes room-wanted ads" ;;
esac

# The wire pin is the rounded pair and nothing else: no owner id, no status, no
# raw coordinate, no debug field.
[ "$(pin_field "$MAP_A_ID" lat < "$WORK/map-pins")" = "37.98" ] \
  || fail "athens pin latitude is not rounded to the grid"
[ "$(pin_field "$MAP_A_ID" lng < "$WORK/map-pins")" = "23.73" ] \
  || fail "athens pin longitude is not rounded to the grid"
[ "$(pin_field "$MAP_C_ID" lat < "$WORK/map-pins")" = "35.24" ] \
  || fail "crete pin latitude is not rounded to the grid"
pass "map pins carry the rounded coordinate"
for KEY in ownerId status lat_unrounded exactLocation description publishedAt createdAt updatedAt; do
  if grep -q "\"${KEY}\"" "$WORK/map-pins"; then
    fail "map pin exposed ${KEY}"
  fi
done
pass "map pins expose no private field"

grep -q '"avatarUrl":null' "$WORK/map-pins" || fail "map pin did not carry the null avatar placeholder"
pass "map pins carry the avatar placeholder"

CODE=$(curl -s -o "$WORK/map-crete" -w '%{http_code}' \
  "${BASE_URL}/api/listings/map?${MAP_QUERY}&regionCode=crete")
assert_status "$CODE" 200 "listings map region filter"
CRETE_PIN_IDS="$(pin_ids < "$WORK/map-crete")"
[ "$CRETE_PIN_IDS" = "$MAP_C_ID" ] || fail "region filter did not narrow the map (got ${CRETE_PIN_IDS})"
pass "listings map narrows by region"

CODE=$(curl -s -o "$WORK/map-kind" -w '%{http_code}' \
  "${BASE_URL}/api/listings/map?${MAP_QUERY}&kind=whole_property")
assert_status "$CODE" 200 "listings map kind filter"
KIND_PIN_IDS="$(pin_ids < "$WORK/map-kind")"
[ "$KIND_PIN_IDS" = "$MAP_B_ID" ] || fail "kind filter did not narrow the map (got ${KIND_PIN_IDS})"
pass "listings map narrows by kind"

CODE=$(curl -s -o "$WORK/map-furnished" -w '%{http_code}' \
  "${BASE_URL}/api/listings/map?${MAP_QUERY}&furnished=true&minSizeSqm=30&maxSizeSqm=30")
assert_status "$CODE" 200 "listings map flag and size filters"
FLAG_PIN_IDS="$(pin_ids < "$WORK/map-furnished")"
[ "$FLAG_PIN_IDS" = "$MAP_A_ID" ] || fail "flag/size filters did not narrow the map (got ${FLAG_PIN_IDS})"
pass "listings map narrows by flags and size"

CODE=$(curl -s -o "$WORK/map-capped" -w '%{http_code}' \
  "${BASE_URL}/api/listings/map?${MAP_QUERY}&limit=2")
assert_status "$CODE" 200 "listings map with a limit"
grep -q '"truncated":true' "$WORK/map-capped" || fail "map limit did not report truncation"
[ "$(node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s).pins.length)))' < "$WORK/map-capped")" = "2" ] \
  || fail "map limit was not respected"
pass "listings map caps the set and reports truncation"

CODE=$(curl -s -o "$WORK/map-exact" -w '%{http_code}' \
  "${BASE_URL}/api/listings/map?${MAP_QUERY}&limit=3")
assert_status "$CODE" 200 "listings map at the exact size"
grep -q '"truncated":false' "$WORK/map-exact" || fail "map reported truncation with nothing left over"
pass "listings map reports an untruncated set"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/map?limit=501")
assert_status "$CODE" 400 "listings map rejects a limit above 500"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/map?minPriceMinor=abc")
assert_status "$CODE" 400 "listings map rejects a malformed filter"

# The literal route cannot be shadowed by /:id, and the detail route still works.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/map")
assert_status "$CODE" 200 "listings map is not shadowed by the detail route"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/listings/${MAP_A_ID}")
assert_status "$CODE" 200 "listing detail still opens"

# The page: server-rendered pins, the configured archive, the promise, and the
# ODbL attribution.
CODE=$(curl -s -o "$WORK/map-page" -w '%{http_code}' "${BASE_URL}/map")
assert_status "$CODE" 200 "map page"
grep -q "${MAP_ATHENS_A}" "$WORK/map-page" || fail "map page did not render the pins"
grep -q 'id="map-data"' "$WORK/map-page" || fail "map page has no pin data block"
grep -q 'maplibre-gl@6.17.0' "$WORK/map-page" || fail "map page does not load the pinned MapLibre build"
grep -q 'pmtiles@4.5.0' "$WORK/map-page" || fail "map page does not load the pinned PMTiles build"
grep -q '@protomaps/basemaps@5.7.2' "$WORK/map-page" || fail "map page does not load the Protomaps style"
grep -q '/maps/greece.pmtiles' "$WORK/map-page" || fail "map page did not read MAP_BASEMAP_URL"
grep -q 'within about 0.75 km' "$WORK/map-page" || fail "map page does not state the error radius"
grep -q 'OpenStreetMap contributors' "$WORK/map-page" || fail "map page dropped the basemap attribution"
grep -q 'href="/map"' "$WORK/map-page" || fail "the header has no map link"
pass "map page renders pins, the map stack, the promise, and the attribution"

# The archive route: a byte range when the placeholder is present, and a clean
# 404 when a fresh checkout has not run `pnpm map:tiles` yet.
CODE=$(curl -s -D "$WORK/map-archive.h" -o "$WORK/map-archive" -w '%{http_code}' \
  -H 'Range: bytes=0-126' "${BASE_URL}/maps/greece.pmtiles")
case "$CODE" in
  206)
    grep -qi '^content-type: application/vnd.pmtiles' "$WORK/map-archive.h" \
      || fail "basemap range response has the wrong content type"
    grep -qi '^content-range: bytes 0-126/' "$WORK/map-archive.h" \
      || fail "basemap range response has no content-range"
    [ "$(head -c 7 "$WORK/map-archive")" = "PMTiles" ] \
      || fail "basemap range response is not a PMTiles archive"
    pass "basemap route serves a PMTiles byte range"
    ;;
  404)
    # The archive is gitignored by design; a fresh checkout shows the degraded
    # banner instead of tiles. That is a valid state, not a failure.
    pass "basemap archive absent (run pnpm map:tiles to serve real tiles)"
    ;;
  *)
    fail "basemap route answered HTTP ${CODE}"
    ;;
esac

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/maps/..%2Fsecret.pmtiles")
assert_status "$CODE" 404 "basemap route rejects a path traversal"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/maps/notes.txt")
assert_status "$CODE" 404 "basemap route rejects a non-pmtiles key"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/maps/missing.pmtiles")
assert_status "$CODE" 404 "basemap route reports a missing archive"

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
printf '%s' "$ROTATED_REFRESH_H" | grep -qi 'samesite=lax' \
  || fail "rotated refresh_token missing SameSite=Lax"
printf '%s' "$(cookie_flags "$WORK/rotate.h" access_token)" | grep -qi 'samesite=lax' \
  || fail "rotated access_token missing SameSite=Lax"
pass "refresh rotation issued new access + refresh cookies (HttpOnly+Secure+SameSite=Lax)"

# 7. multipart upload
printf 'hello estia multipart smoke test\n' > "$WORK/smoke.txt"
CODE=$(curl -s -o "$WORK/multipart" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/test-post" \
  -F "file=@$WORK/smoke.txt;type=text/plain")
assert_status "$CODE" 200 "multipart upload"
grep -q 'Successful' "$WORK/multipart" || fail "multipart upload response body"
pass "multipart upload response body"

# 8. the payload-less role switch on the JSON API
#
# It is a simple request too, so a sibling site is refused outright while the
# app's own page is allowed through. The switch opens the profile for the new
# role where that is possible (listing needs only the user id), and refuses the
# switch where it is not (seeking needs a profile the request does not carry).
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H 'Sec-Fetch-Site: same-site' \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 403 "the API refuses a role switch from a sibling site"

CODE=$(curl -s -o "$WORK/change-role" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "a role switch from the app's own origin"
grep -q '"newProfile"' "$WORK/change-role" \
  || fail "the role switch did not return the new profile"
grep -q '"ownership":"owner"' "$WORK/change-role" \
  || fail "the role switch did not return a lister profile"
pass "a role switch from the app's own origin returns the profile it provisioned"

# The same cookie, no new token: the role a request is authorised against comes
# from the account row, so the switch is live immediately instead of when the
# token happens to be reissued.
CODE=$(curl -s -o "$WORK/me-after-role" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "current-user /api/users/me after a role switch"
grep -q '"role":"lister"' "$WORK/me-after-role" \
  || fail "the role switch did not take effect on the same token"
pass "a role switch takes effect on the same token"

# A freshly registered account is not a seeker or a lister yet, so it has no
# role to switch between: the switch is refused instead of guessing listing.
SECOND_USER_ID="$(user_id_from_token "$SECOND_ACCESS")"
CODE=$(curl -s -o "$WORK/change-role-unassigned" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 409 "a role switch on an unassigned account is refused"
grep -q 'UnassignedRoleSwitchError' "$WORK/change-role-unassigned" \
  || fail "the unassigned role switch did not say why"
UNASSIGNED_LISTERS=$(pnpm exec wrangler d1 execute "$DB_BINDING" --local --json \
  --command "SELECT COUNT(*) AS total FROM listers WHERE user_id='${SECOND_USER_ID}';" 2>/dev/null \
  | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s)[0].results[0].total)))')
[ "$UNASSIGNED_LISTERS" = "0" ] \
  || fail "an unassigned role switch opened a lister profile (${UNASSIGNED_LISTERS} rows)"
pass "an unassigned account cannot become a lister by switching"

# Once the account is set up to seek, the switch to listing provisions the row.
pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "UPDATE users SET role='seeker' WHERE id='${SECOND_USER_ID}';" \
  >/dev/null 2>&1 || fail "seed second account seeker role"
CODE=$(curl -s -o "$WORK/change-role-second" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "a second account switches to listing"

# Switching back to seeking cannot be invented: a seeker profile needs a name, a
# date of birth, and a gender, which a payload-less switch does not carry. The
# switch is refused with a reason and the account is left exactly as it was.
CODE=$(curl -s -o "$WORK/change-role-refused" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 409 "a switch to seeking without a seeker profile is refused"
grep -q 'seeker profile has to be completed first' "$WORK/change-role-refused" \
  || fail "the refused role switch did not explain itself"
pass "the refused role switch explains that a seeker profile has to be completed first"

CODE=$(curl -s -o "$WORK/me-second" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "the second account's /api/users/me after a refused switch"
grep -q '"role":"lister"' "$WORK/me-second" \
  || fail "the refused role switch changed the account anyway"
pass "a refused role switch leaves the account's role alone"

# The refusal never left a role pointing at a profile that does not exist: the
# seeker table gained no row for this account, and `me` answered with the lister
# profile the account really has.
SEEKER_ROWS=$(pnpm exec wrangler d1 execute "$DB_BINDING" --local --json \
  --command "SELECT COUNT(*) AS total FROM seekers WHERE user_id='${SECOND_USER_ID}';" 2>/dev/null \
  | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s)[0].results[0].total)))')
[ "$SEEKER_ROWS" = "0" ] \
  || fail "the refused role switch created a seeker profile (${SEEKER_ROWS} rows)"
pass "a refused role switch creates no profile row"

# 8b. the corrupted state the old code left behind - a stored lister role whose
# lister row was never created - heals on the next switch instead of stranding
# the account with a role that points at nothing.
pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "DELETE FROM listers WHERE user_id='${SECOND_USER_ID}';" \
  >/dev/null 2>&1 || fail "seed the corrupt lister state"

CODE=$(curl -s -o "$WORK/change-role-healed" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "a stored lister role with no lister row heals"
grep -q '"ownership":"owner"' "$WORK/change-role-healed" \
  || fail "the healing switch did not return the lister profile"
CODE=$(curl -s -o "$WORK/me-healed" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "the healed account's /api/users/me"
grep -q '"role":"lister"' "$WORK/me-healed" \
  || fail "the healing switch changed the stored role"
grep -q '"userProfile":{' "$WORK/me-healed" \
  || fail "the healed account's profile call did not report the lister profile"
HEALED_LISTERS=$(pnpm exec wrangler d1 execute "$DB_BINDING" --local --json \
  --command "SELECT COUNT(*) AS total FROM listers WHERE user_id='${SECOND_USER_ID}';" 2>/dev/null \
  | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s)[0].results[0].total)))')
[ "$HEALED_LISTERS" = "1" ] \
  || fail "the healing switch did not leave exactly one lister row (${HEALED_LISTERS} rows)"
pass "a stored lister role with no lister row heals and reports its profile"

# 8c. an admin has no profile to switch between, and must never be demoted by a
# payload-less switch.
pnpm exec wrangler d1 execute "$DB_BINDING" --local \
  --command "UPDATE users SET role='admin' WHERE id='${SECOND_USER_ID}';" \
  >/dev/null 2>&1 || fail "seed admin role"
CODE=$(curl -s -o "$WORK/change-role-admin" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 403 "a role switch on an admin account is refused"
grep -q 'AdminRoleSwitchError' "$WORK/change-role-admin" \
  || fail "the admin role switch did not say why"
grep -q '"role":"admin"' <(curl -s "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${SECOND_ACCESS}") \
  || fail "the refused switch demoted the admin"
pass "an admin cannot be switched and stays admin"

echo "smoke checklist passed"
