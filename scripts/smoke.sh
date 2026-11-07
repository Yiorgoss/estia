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
