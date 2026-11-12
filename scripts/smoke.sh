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

# How many profile rows the app has for one account, asked of the database
# rather than of an API response.
profile_rows() {
  # $1: table name, $2: user id
  pnpm exec wrangler d1 execute "$DB_BINDING" --local --json \
    --command "SELECT COUNT(*) AS total FROM $1 WHERE user_id='$2';" 2>/dev/null \
    | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s)[0].results[0].total)))'
}

# One SQL statement against the local database, for the checks that have to put
# an account into a state no request would produce.
db_exec() {
  pnpm exec wrangler d1 execute "$DB_BINDING" --local --command "$1" >/dev/null 2>&1 \
    || fail "database statement failed: $1"
}

# One value read back from the local database, for the checks that have to prove
# what a request did to a row instead of inferring it from a later response.
db_scalar() {
  pnpm exec wrangler d1 execute "$DB_BINDING" --local --json --command "$1" 2>/dev/null \
    | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(String(JSON.parse(s)[0].results[0].value)))'
}

# The digest a refresh token is stored under: the app hashes the token and keys
# the row on the hash, so a check that names a row has to hash it the same way.
token_hash() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
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
[ "$FORM_LOCATION" = "/profile" ] \
  || fail "form register did not redirect to the profile page (got ${FORM_LOCATION:-no Location header})"
pass "form register redirects to the profile page"
FORM_ACCESS="$(cookie_value "$WORK/form-register.h" access_token)"
FORM_REFRESH="$(cookie_value "$WORK/form-register.h" refresh_token)"
[ -n "$FORM_ACCESS" ] && [ -n "$FORM_REFRESH" ] || fail "form register set the session cookies"
pass "form register sets the session cookies"

# 2c. the profile a new account lands on: registration opened both profiles, the
# page edits the seeking one, and it says the profile is incomplete until the
# required fields are filled in.
CODE=$(curl -s -o "$WORK/profile-fresh" -w '%{http_code}' "${BASE_URL}/profile" \
  -H "Cookie: access_token=${FORM_ACCESS}")
assert_status "$CODE" 200 "the profile page for a new account"
grep -q 'action="/profile"' "$WORK/profile-fresh" \
  || fail "the profile page has no form"
grep -q 'Your seeking profile is incomplete' "$WORK/profile-fresh" \
  || fail "a new account's profile page does not say it is incomplete"
grep -q 'href="/profile"' "$WORK/profile-fresh" \
  || fail "the header has no profile link"
pass "a new account lands on an incomplete profile page"

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

# 3b. a fresh sign-up is a complete account: registration opens one seeking and
# one listing profile for it, so no account exists without a profile to switch to.
USER_ID="$(user_id_from_token "$ACCESS")"
FRESH_SEEKERS="$(profile_rows seekers "$USER_ID")"
FRESH_LISTERS="$(profile_rows listers "$USER_ID")"
[ "$FRESH_SEEKERS" = "1" ] \
  || fail "registration did not open exactly one seeker profile (${FRESH_SEEKERS} rows)"
[ "$FRESH_LISTERS" = "1" ] \
  || fail "registration did not open exactly one lister profile (${FRESH_LISTERS} rows)"
pass "registration opens one seeker and one lister profile"

# The profile call reports the seeking profile registration opened, with the
# fields nobody has filled in yet carrying nulls instead of invented values.
CODE=$(curl -s -o "$WORK/me-fresh" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "fresh user /api/users/me"
grep -q '"role":"seeker"' "$WORK/me-fresh" \
  || fail "the fresh user's profile call did not report the registered role"
grep -q "\"userId\":\"${USER_ID}\"" "$WORK/me-fresh" \
  || fail "the fresh user's profile call did not report the profile registration opened"
grep -q '"name":null' "$WORK/me-fresh" \
  || fail "the fresh user's blank seeking profile did not report a null name"
pass "a fresh user's /api/users/me reports the blank seeking profile"

# 4. complete the seeking profile through the profile API, then current-user.
# This is the same write the profile page makes, so the update path is exercised
# end to end rather than by editing the row behind the app's back.
CODE=$(curl -s -o "$WORK/profile-read" -w '%{http_code}' "${BASE_URL}/api/users/profile" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "the profile API reads a fresh account's seeking profile"
grep -q '"role":"seeker"' "$WORK/profile-read" \
  || fail "the profile API did not report the stored role"
grep -q '"name":null' "$WORK/profile-read" \
  || fail "a fresh account's profile API did not report a blank seeking profile"
pass "the profile API reads the blank seeking profile registration opened"

CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X PUT "${BASE_URL}/api/users/profile" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Nobody","dateOfBirth":946684800000,"gender":"NB"}')
assert_status "$CODE" 401 "the profile API rejects an unauthenticated save"

CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X PUT "${BASE_URL}/api/users/profile" \
  -H 'Content-Type: application/json' \
  -H "Cookie: access_token=${ACCESS}" \
  -d '{"name":"   ","dateOfBirth":946684800000,"gender":"NB"}')
assert_status "$CODE" 400 "the profile API rejects a blank required name"

CODE=$(curl -s -o "$WORK/profile-save" -w '%{http_code}' \
  -X PUT "${BASE_URL}/api/users/profile" \
  -H 'Content-Type: application/json' \
  -H "Cookie: access_token=${ACCESS}" \
  -d '{"name":"Smoke User","dateOfBirth":946684800000,"gender":"NB","bio":"Smoke bio","smoking":1,"pets":0}')
assert_status "$CODE" 200 "the profile API saves a seeking profile"
grep -q '"name":"Smoke User"' "$WORK/profile-save" \
  || fail "the profile save did not store the name"
grep -q '"bio":"Smoke bio"' "$WORK/profile-save" \
  || fail "the profile save did not store the bio"
grep -q "\"userId\":\"${USER_ID}\"" "$WORK/profile-save" \
  || fail "the profile save answered with another account's profile"
pass "the profile API saves a seeking profile"

# The page's own form is the surface a browser uses. It redirects after a save so
# a refresh cannot repeat the write, and the saved page re-reads the stored row.
CODE=$(curl -s -D "$WORK/profile-page-save.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/profile" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${ACCESS}" \
  --data-urlencode 'name=Smoke User' \
  --data-urlencode 'dateOfBirth=2000-01-01' \
  --data-urlencode 'gender=NB' \
  --data-urlencode 'bio=Smoke bio' \
  --data-urlencode 'smoking=true')
assert_status "$CODE" 303 "the profile page saves the seeking form"
PROFILE_LOCATION="$(header_value "$WORK/profile-page-save.h" location)"
[ "$PROFILE_LOCATION" = "/profile?saved=1" ] \
  || fail "the profile page did not redirect to its saved state (got ${PROFILE_LOCATION:-no Location header})"
CODE=$(curl -s -o "$WORK/profile-page-saved" -w '%{http_code}' \
  "${BASE_URL}/profile?saved=1" -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "the saved profile page"
grep -q 'Your profile was saved.' "$WORK/profile-page-saved" \
  || fail "the saved profile page did not report the save"
grep -q 'value="Smoke User"' "$WORK/profile-page-saved" \
  || fail "the saved profile page did not re-read the stored name"
if grep -q 'Your seeking profile is incomplete' "$WORK/profile-page-saved"; then
  fail "a completed seeking profile is still reported incomplete"
fi
pass "the profile page saves and reflects the stored profile"

CODE=$(curl -s -o "$WORK/me" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "current-user /api/users/me"
grep -q '"userProfile"' "$WORK/me" || fail "current-user response has userProfile"
grep -q '"name":"Smoke User"' "$WORK/me" \
  || fail "the profile update did not reach the stored profile"
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
grep -q '/maps/greece.pmtiles' "$WORK/map-page" || fail "map page did not embed the default PMTILES_GREECE path"
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

# 5g. saved searches
#
# The search page stays the visitor's page: no saved-search control and no list
# without a session, and a save without one is refused. A signed-in save from
# the results page is then listed by the search page with every criterion the
# results route needs, re-run from the saved search's own link, and deleted from
# the page control.
SAVED_NAME="Smoke saved search ${SMOKE_TAG}"
SAVED_NAME_2="Smoke saved search two ${SMOKE_TAG}"

# The newest row of the saved-search panel, as the id its delete control posts.
saved_id_of() {
  sed -nE 's|.*action="/search/saved/([0-9]+)/delete".*|\1|p' "$1" | head -1
}

CODE=$(curl -s -o "$WORK/search-anon" -w '%{http_code}' "${BASE_URL}/search")
assert_status "$CODE" 200 "search page for a visitor"
if grep -q 'id="saved-searches"' "$WORK/search-anon"; then
  fail "the search page rendered a saved-search list for a visitor"
fi
if grep -q 'hx-post="/search/saved"' "$WORK/search-anon"; then
  fail "the search page rendered a save control for a visitor"
fi
pass "a visitor sees no saved-search UI"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/search/saved" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "name=${SAVED_NAME}")
assert_status "$CODE" 401 "saving a search without a session is refused"

CODE=$(curl -s -o "$WORK/search-results-anon" -w '%{http_code}' \
  "${BASE_URL}/search/results?${FRAGMENT_QUERY}")
assert_status "$CODE" 200 "search results for a visitor"
if grep -q 'hx-post="/search/saved"' "$WORK/search-results-anon"; then
  fail "the results fragment offered a visitor a save control"
fi
pass "a visitor's results fragment has no save control"

CODE=$(curl -s -o "$WORK/search-results-signed" -w '%{http_code}' \
  "${BASE_URL}/search/results?${FRAGMENT_QUERY}" -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "search results for a signed-in caller"
grep -q 'hx-post="/search/saved"' "$WORK/search-results-signed" \
  || fail "the results fragment did not offer a signed-in caller a save control"
grep -q 'hx-include="#search-form"' "$WORK/search-results-signed" \
  || fail "the save control does not capture the current search form"
pass "a signed-in caller can save the current search"

# Saving from the results page: the form's own field is the optional name, and
# the criteria travel from the search form through hx-include.
CODE=$(curl -s -o "$WORK/saved-create" -w '%{http_code}' -X POST "${BASE_URL}/search/saved" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'HX-Request: true' \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${ACCESS}" \
  --data-urlencode "name=${SAVED_NAME}" \
  --data-urlencode 'query=' \
  --data-urlencode 'regionCode=crete' \
  --data-urlencode 'kind=' \
  --data-urlencode "minPrice=${SMOKE_EUR}" \
  --data-urlencode "maxPrice=${SMOKE_EUR}" \
  --data-urlencode 'minSizeSqm=' \
  --data-urlencode 'maxSizeSqm=' \
  --data-urlencode 'availableFrom=')
assert_status "$CODE" 200 "saving a search from the results page"
grep -q "${SAVED_NAME}" "$WORK/saved-create" || fail "the save response did not list the saved search"
grep -q 'hx-swap-oob="true"' "$WORK/saved-create" || fail "the save response did not clear the name box"
SAVED_ID="$(saved_id_of "$WORK/saved-create")"
[ -n "$SAVED_ID" ] || fail "the save response did not name the saved search's id"
pass "the saved search appears in the list with a delete control"

# The page a saved-search link opens is pre-filled with the stored criteria and
# asks the results fragment for exactly those criteria on load.
CODE=$(curl -s -o "$WORK/saved-applied" -w '%{http_code}' \
  "${BASE_URL}/search?saved=${SAVED_ID}" -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "the saved search's page"
grep -q "${SAVED_NAME}" "$WORK/saved-applied" || fail "the applied page did not list the saved search"
grep -q '<option value="crete" selected>' "$WORK/saved-applied" \
  || fail "the applied page did not pre-fill the region"
grep -q "value=\"${SMOKE_EUR}\"" "$WORK/saved-applied" \
  || fail "the applied page did not pre-fill the price"
grep -q "hx-get=\"/search/results?.*regionCode=crete" "$WORK/saved-applied" \
  || fail "the applied page did not ask for the saved criteria"
pass "applying a saved search pre-fills the form and the results request"

APPLY_QUERY="regionCode=crete&minPriceMinor=${SMOKE_MINOR}&maxPriceMinor=${SMOKE_MINOR}"
CODE=$(curl -s -o "$WORK/saved-rerun" -w '%{http_code}' \
  "${BASE_URL}/search/results?${APPLY_QUERY}" -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "re-running a saved search"
grep -q "${CRETE_TITLE}" "$WORK/saved-rerun" || fail "the re-run dropped the crete listing"
if grep -q "${EPIRUS_TITLE}" "$WORK/saved-rerun"; then
  fail "the re-run did not narrow to the saved region"
fi
pass "a saved search re-runs the same search"

# Another account can neither see nor delete it.
CODE=$(curl -s -o "$WORK/saved-other-page" -w '%{http_code}' \
  "${BASE_URL}/search" -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "another account's search page"
if grep -q "${SAVED_NAME}" "$WORK/saved-other-page"; then
  fail "another account's search page leaked a saved search"
fi
CODE=$(curl -s -o "$WORK/saved-other-delete" -w '%{http_code}' -X POST \
  "${BASE_URL}/search/saved/${SAVED_ID}/delete" \
  -H 'HX-Request: true' \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "another account's delete of someone else's saved search"
grep -q 'That saved search no longer exists.' "$WORK/saved-other-delete" \
  || fail "another account's delete did not read as no such saved search"
CODE=$(curl -s -o "$WORK/saved-after-other" -w '%{http_code}' \
  "${BASE_URL}/search" -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "the owner's search page after another account's delete"
grep -q "${SAVED_NAME}" "$WORK/saved-after-other" \
  || fail "another account's delete removed the owner's saved search"
pass "another account's saved searches are never readable or deletable"

# A delete from the page control replaces the list in place.
CODE=$(curl -s -o "$WORK/saved-delete" -w '%{http_code}' -X POST \
  "${BASE_URL}/search/saved/${SAVED_ID}/delete" \
  -H 'HX-Request: true' \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "deleting a saved search from the page"
grep -q 'Saved search deleted.' "$WORK/saved-delete" || fail "the delete response did not confirm it"
if grep -q "${SAVED_NAME}" "$WORK/saved-delete"; then
  fail "the deleted saved search stayed in the list"
fi
CODE=$(curl -s -o "$WORK/saved-gone" -w '%{http_code}' \
  "${BASE_URL}/search" -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "the search page after a delete"
if grep -q "${SAVED_NAME}" "$WORK/saved-gone"; then
  fail "the deleted saved search is still listed"
fi
pass "deleting a saved search removes it from the list"

# The same delete without htmx is a navigation: a redirect back to the search
# page rather than a bare fragment.
CODE=$(curl -s -o "$WORK/saved-create-2" -w '%{http_code}' -X POST "${BASE_URL}/search/saved" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'HX-Request: true' \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${ACCESS}" \
  --data-urlencode "name=${SAVED_NAME_2}" \
  --data-urlencode 'kind=room')
assert_status "$CODE" 200 "saving a second search from the results page"
SAVED_ID_2="$(saved_id_of "$WORK/saved-create-2")"
[ -n "$SAVED_ID_2" ] || fail "the second save response did not name its id"
CODE=$(curl -s -D "$WORK/saved-delete-redirect.h" -o /dev/null -w '%{http_code}' -X POST \
  "${BASE_URL}/search/saved/${SAVED_ID_2}/delete" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 303 "a delete without htmx redirects"
SAVED_LOCATION=$(grep -i '^location:' "$WORK/saved-delete-redirect.h" | head -1 | tr -d '\r' | sed -E 's/^[Ll]ocation: //')
[ "$SAVED_LOCATION" = "/search" ] || fail "the delete redirect did not go to the search page"
pass "a delete without htmx redirects to the search page"

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

# 6b. a deliberate refresh, and a proper end to the session
#
# The refresh route is the way a client renews on purpose instead of waiting for
# a private request to fail first. It consumes the presented refresh token and
# rotates it exactly as the middleware just did, answering with a fresh pair of
# cookies and the current user. The session it just rotated is the one signing
# out below ends for good: logout revokes the refresh token and clears both
# cookies, so the month-long credential cannot be replayed from the device.
CODE=$(curl -s -D "$WORK/api-refresh.h" -o "$WORK/api-refresh" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/refresh" \
  -H "Cookie: refresh_token=${ROTATED_REFRESH}")
assert_status "$CODE" 200 "api refresh"
grep -q "\"id\":\"${USER_ID}\"" "$WORK/api-refresh" \
  || fail "api refresh did not answer with the current user"
grep -q '"role":"seeker"' "$WORK/api-refresh" \
  || fail "api refresh did not answer with the stored role"
FRESH_ACCESS="$(cookie_value "$WORK/api-refresh.h" access_token)"
FRESH_REFRESH="$(cookie_value "$WORK/api-refresh.h" refresh_token)"
[ -n "$FRESH_ACCESS" ] && [ -n "$FRESH_REFRESH" ] || fail "api refresh did not set both cookies"
[ "$FRESH_REFRESH" != "$ROTATED_REFRESH" ] || fail "api refresh did not rotate the token"
FRESH_REFRESH_H=$(cookie_flags "$WORK/api-refresh.h" refresh_token)
printf '%s' "$FRESH_REFRESH_H" | grep -qi 'httponly' || fail "api refresh refresh_token missing HttpOnly"
printf '%s' "$FRESH_REFRESH_H" | grep -qi 'secure' || fail "api refresh refresh_token missing Secure"
printf '%s' "$FRESH_REFRESH_H" | grep -qi 'samesite=lax' \
  || fail "api refresh refresh_token missing SameSite=Lax"
printf '%s' "$(cookie_flags "$WORK/api-refresh.h" access_token)" | grep -qi 'samesite=lax' \
  || fail "api refresh access_token missing SameSite=Lax"
pass "api refresh returns fresh cookies and the current user"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${FRESH_ACCESS}")
assert_status "$CODE" 200 "the access cookie a refresh issued opens a private route"

# The token the refresh consumed is dead: replaying it is a 401 with no cookies.
CODE=$(curl -s -D "$WORK/api-refresh-replay.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/refresh" \
  -H "Cookie: refresh_token=${ROTATED_REFRESH}")
assert_status "$CODE" 401 "api refresh rejects a replayed token"
[ -z "$(cookie_flags "$WORK/api-refresh-replay.h" refresh_token)" ] \
  || fail "a replayed refresh token set a cookie"
pass "a replayed refresh token answers 401 and sets nothing"

# The control on the profile page is the browser's way out.
CODE=$(curl -s -o "$WORK/profile-logout" -w '%{http_code}' "${BASE_URL}/profile" \
  -H "Cookie: access_token=${FRESH_ACCESS}")
assert_status "$CODE" 200 "the profile page"
grep -q 'action="/api/auth/logout"' "$WORK/profile-logout" \
  || fail "the profile page offers no way to log out"
grep -q '>Log out</button>' "$WORK/profile-logout" \
  || fail "the profile page logout control is not labelled Log out"
# The all-devices action is a separate control with its own wording, so the two
# are distinguishable on the page.
grep -q 'action="/api/auth/logout-all"' "$WORK/profile-logout" \
  || fail "the profile page offers no way to sign out of every device"
grep -q '>Sign out of all devices</button>' "$WORK/profile-logout" \
  || fail "the profile page all-devices control is not labelled Sign out of all devices"
grep -q 'ends every session on this account' "$WORK/profile-logout" \
  || fail "the profile page does not say what signing out of all devices does"
pass "the profile page offers a log out control and a separate all-devices control"

# A browser posts that control: a redirect to the sign-in page and both cookies
# cleared. The access cookie is deliberately absent, because the person may click
# log out after it has already expired.
CODE=$(curl -s -D "$WORK/logout-form.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/logout" \
  -H 'Accept: text/html' \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: refresh_token=${FRESH_REFRESH}")
assert_status "$CODE" 303 "form logout"
LOGOUT_LOCATION=$(grep -i '^location:' "$WORK/logout-form.h" | head -1 | tr -d '\r' | sed -E 's/^[Ll]ocation: //')
[ "$LOGOUT_LOCATION" = "/login" ] \
  || fail "form logout did not redirect to /login (got ${LOGOUT_LOCATION:-no Location header})"
for NAME in access_token refresh_token; do
  CLEARED_H=$(cookie_flags "$WORK/logout-form.h" "$NAME")
  [ -n "$CLEARED_H" ] || fail "logout did not clear ${NAME}"
  printf '%s' "$CLEARED_H" | grep -qi 'max-age=0' || fail "cleared ${NAME} has a lifetime left"
  printf '%s' "$CLEARED_H" | grep -qi 'path=/' || fail "cleared ${NAME} has the wrong path"
  printf '%s' "$CLEARED_H" | grep -qi 'httponly' || fail "cleared ${NAME} missing HttpOnly"
  printf '%s' "$CLEARED_H" | grep -qi 'secure' || fail "cleared ${NAME} missing Secure"
  printf '%s' "$CLEARED_H" | grep -qi 'samesite=lax' || fail "cleared ${NAME} missing SameSite=Lax"
done
pass "form logout redirects to the sign-in page and clears both cookies"

# The row is revoked in the database, not merely forgotten by the browser, and
# the token a signed-out device still holds is refused if it is replayed.
FRESH_REFRESH_HASH="$(token_hash "$FRESH_REFRESH")"
REVOKED="$(db_scalar "SELECT COUNT(*) AS value FROM refresh_tokens WHERE token_hash='${FRESH_REFRESH_HASH}' AND revoked_at IS NOT NULL;")"
[ "$REVOKED" = "1" ] || fail "logout did not revoke the refresh token row (${REVOKED} revoked rows)"
CODE=$(curl -s -D "$WORK/api-refresh-after-logout.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/refresh" \
  -H "Cookie: refresh_token=${FRESH_REFRESH}")
assert_status "$CODE" 401 "api refresh rejects a token replayed after logout"
[ -z "$(cookie_flags "$WORK/api-refresh-after-logout.h" refresh_token)" ] \
  || fail "a token replayed after logout set a cookie"
pass "logout revokes the row and a replayed token answers 401 with no cookies"

# Signed out already: a 204 and nothing to revoke is the same harmless answer.
CODE=$(curl -s -o "$WORK/logout-signed-out" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/logout")
assert_status "$CODE" 204 "logout while signed out"
[ ! -s "$WORK/logout-signed-out" ] || fail "logout while signed out answered with a body"
pass "logging out while signed out is harmless"

# 6c. signing out of every device
#
# The separate action ends every session the account has, not only the one that
# asks: this account signs in twice more - once as another device, once as an
# earlier visit - and both refresh tokens have to die with it, while a second
# account's live session is untouched. The rows are read back from the database,
# because that is where the promise lives.
EVERY_EMAIL="smoke-everywhere-$(date +%s)@test.local"
CODE=$(curl -s -D "$WORK/every-register.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${EVERY_EMAIL}\",\"password\":\"${PASSWORD}\"}")
assert_status "$CODE" 200 "register the all-devices smoke user"
EVERY_ACCESS="$(cookie_value "$WORK/every-register.h" access_token)"
EVERY_REFRESH="$(cookie_value "$WORK/every-register.h" refresh_token)"
EVERY_ID="$(user_id_from_token "$EVERY_ACCESS")"

for N in 1 2; do
  CODE=$(curl -s -D "$WORK/every-login-${N}.h" -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${EVERY_EMAIL}\",\"password\":\"${PASSWORD}\"}")
  assert_status "$CODE" 200 "the all-devices smoke user signs in again (${N})"
done
EVERY_ACCESS_2="$(cookie_value "$WORK/every-login-1.h" access_token)"
EVERY_REFRESH_2="$(cookie_value "$WORK/every-login-1.h" refresh_token)"
EVERY_REFRESH_3="$(cookie_value "$WORK/every-login-2.h" refresh_token)"
[ -n "$EVERY_ACCESS_2" ] && [ -n "$EVERY_REFRESH_2" ] && [ -n "$EVERY_REFRESH_3" ] \
  || fail "the repeated sign-ins did not set session cookies"
EVERY_LIVE="$(db_scalar "SELECT COUNT(*) AS value FROM refresh_tokens WHERE user_id='${EVERY_ID}' AND revoked_at IS NULL;")"
[ "$EVERY_LIVE" = "3" ] || fail "the account does not have three live sessions (${EVERY_LIVE})"
pass "one account holds three live sessions from three sign-ins"

# A page on another site can post this URL with the cookie attached, so a foreign
# origin is refused before anything is revoked.
CODE=$(curl -s -o "$WORK/every-cross-site" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/logout-all" \
  -H 'Origin: https://evil.example' \
  -H "Cookie: access_token=${EVERY_ACCESS}; refresh_token=${EVERY_REFRESH}")
assert_status "$CODE" 403 "signing out of every device from another site is refused"
EVERY_LIVE="$(db_scalar "SELECT COUNT(*) AS value FROM refresh_tokens WHERE user_id='${EVERY_ID}' AND revoked_at IS NULL;")"
[ "$EVERY_LIVE" = "3" ] || fail "a cross-site logout-all revoked a token (${EVERY_LIVE} live)"
pass "a refused cross-site logout-all changes nothing"

# The JSON client's answer: an empty 204 with both cookies cleared.
CODE=$(curl -s -D "$WORK/every-logout.h" -o "$WORK/every-logout" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/logout-all" \
  -H "Cookie: access_token=${EVERY_ACCESS}; refresh_token=${EVERY_REFRESH}")
assert_status "$CODE" 204 "signing out of every device"
[ ! -s "$WORK/every-logout" ] || fail "logout-all answered with a body"
for NAME in access_token refresh_token; do
  CLEARED_H=$(cookie_flags "$WORK/every-logout.h" "$NAME")
  [ -n "$CLEARED_H" ] || fail "logout-all did not clear ${NAME}"
  printf '%s' "$CLEARED_H" | grep -qi 'max-age=0' || fail "cleared ${NAME} has a lifetime left"
done
pass "signing out of every device clears both session cookies"

EVERY_LIVE="$(db_scalar "SELECT COUNT(*) AS value FROM refresh_tokens WHERE user_id='${EVERY_ID}' AND revoked_at IS NULL;")"
[ "$EVERY_LIVE" = "0" ] || fail "logout-all left ${EVERY_LIVE} live refresh token(s)"
EVERY_ROWS="$(db_scalar "SELECT COUNT(*) AS value FROM refresh_tokens WHERE user_id='${EVERY_ID}';")"
[ "$EVERY_ROWS" = "3" ] || fail "logout-all changed the number of session rows (${EVERY_ROWS})"
pass "signing out of every device revoked all three refresh tokens"

# The other two devices still hold their tokens; replaying either is a 401 with
# no cookies, so the revocation is in the database and not just in this browser.
for TOKEN in "$EVERY_REFRESH_2" "$EVERY_REFRESH_3"; do
  CODE=$(curl -s -D "$WORK/every-replay.h" -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/api/auth/refresh" \
    -H "Cookie: refresh_token=${TOKEN}")
  assert_status "$CODE" 401 "a revoked device's refresh token is rejected"
  [ -z "$(cookie_flags "$WORK/every-replay.h" refresh_token)" ] \
    || fail "a revoked refresh token set a cookie"
done
pass "replaying any revoked refresh token answers 401 and sets nothing"

# Another account's session is not this account's to end.
SECOND_USER_ID="$(user_id_from_token "$SECOND_ACCESS")"
SECOND_LIVE="$(db_scalar "SELECT COUNT(*) AS value FROM refresh_tokens WHERE user_id='${SECOND_USER_ID}' AND revoked_at IS NULL;")"
[ "$SECOND_LIVE" -ge 1 ] || fail "logout-all revoked another account's refresh token"
pass "another account's live session survives"

# The profile page's control, posted by a browser: a redirect to the sign-in page
# and both cookies cleared. This ends the second account's sessions, which is the
# last use of its refresh token in this checklist.
SECOND_REFRESH="$(cookie_value "$WORK/register-second.h" refresh_token)"
CODE=$(curl -s -D "$WORK/every-form.h" -o /dev/null -w '%{http_code}' \
  -X POST "${BASE_URL}/api/auth/logout-all" \
  -H 'Accept: text/html' \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: refresh_token=${SECOND_REFRESH}")
assert_status "$CODE" 303 "form sign out of every device"
EVERY_LOCATION=$(header_value "$WORK/every-form.h" location)
[ "$EVERY_LOCATION" = "/login" ] \
  || fail "form logout-all did not redirect to /login (got ${EVERY_LOCATION:-no Location header})"
for NAME in access_token refresh_token; do
  CLEARED_H=$(cookie_flags "$WORK/every-form.h" "$NAME")
  [ -n "$CLEARED_H" ] || fail "form logout-all did not clear ${NAME}"
  printf '%s' "$CLEARED_H" | grep -qi 'max-age=0' || fail "cleared ${NAME} has a lifetime left"
done
SECOND_LIVE="$(db_scalar "SELECT COUNT(*) AS value FROM refresh_tokens WHERE user_id='${SECOND_USER_ID}' AND revoked_at IS NULL;")"
[ "$SECOND_LIVE" = "0" ] || fail "the form action left ${SECOND_LIVE} live token(s) for its account"
pass "the profile page control redirects to sign-in, clears cookies, and ends every session"

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
# app's own page is allowed through. Registration opened both profiles for this
# account, so a switch is a plain flip between them: it carries no payload, opens
# nothing, and answers with the profile the new role points at.
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
grep -q "\"userId\":\"${USER_ID}\"" "$WORK/change-role" \
  || fail "the role switch returned another account's profile"
pass "a role switch from the app's own origin flips to the listing profile"

# The same cookie, no new token: the role a request is authorised against comes
# from the account row, so the switch is live immediately instead of when the
# token happens to be reissued.
CODE=$(curl -s -o "$WORK/me-after-role" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "current-user /api/users/me after a role switch"
grep -q '"role":"lister"' "$WORK/me-after-role" \
  || fail "the role switch did not take effect on the same token"
grep -q '"ownership":"owner"' "$WORK/me-after-role" \
  || fail "the switched account's profile call did not report the lister profile"
pass "a role switch takes effect on the same token"

# The listing profile saves its own shape through the same endpoint: the server
# matches the payload to the role the account holds now.
CODE=$(curl -s -o "$WORK/profile-lister" -w '%{http_code}' \
  -X PUT "${BASE_URL}/api/users/profile" \
  -H 'Content-Type: application/json' \
  -H "Cookie: access_token=${ACCESS}" \
  -d '{"name":"Smoke Lets","ownership":"leaseholder"}')
assert_status "$CODE" 200 "the profile API saves a listing profile"
grep -q '"ownership":"leaseholder"' "$WORK/profile-lister" \
  || fail "the listing profile save did not store the ownership"
grep -q '"name":"Smoke Lets"' "$WORK/profile-lister" \
  || fail "the listing profile save did not store the display name"
grep -q '"role":"lister"' "$WORK/profile-lister" \
  || fail "the listing profile save did not report the listing role"
pass "the profile API saves a listing profile"

# Switching back is the same plain flip in the other direction, and answers with
# the seeking profile registration already opened and the person completed.
CODE=$(curl -s -o "$WORK/change-role-back" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "a role switch back to seeking"
grep -q '"name":"Smoke User"' "$WORK/change-role-back" \
  || fail "the switch back to seeking did not return the completed seeking profile"
CODE=$(curl -s -o "$WORK/me-after-role-back" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${ACCESS}")
assert_status "$CODE" 200 "current-user /api/users/me after switching back"
grep -q '"role":"seeker"' "$WORK/me-after-role-back" \
  || fail "the switch back to seeking did not change the stored role"
grep -q '"name":"Smoke User"' "$WORK/me-after-role-back" \
  || fail "the switched account's profile call did not report the seeking profile"
pass "a role switch back to seeking answers with the seeking profile"

# 8b. an account that predates registration provisioning has no profile rows at
# all, and must still repair itself instead of stranding its role on nothing.
SECOND_USER_ID="$(user_id_from_token "$SECOND_ACCESS")"
db_exec "DELETE FROM seekers WHERE user_id='${SECOND_USER_ID}';"
db_exec "DELETE FROM listers WHERE user_id='${SECOND_USER_ID}';"
db_exec "UPDATE users SET role='seeker' WHERE id='${SECOND_USER_ID}';"

CODE=$(curl -s -o "$WORK/change-role-healed" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "an account with no profile rows heals on its next switch"
grep -q '"ownership":"owner"' "$WORK/change-role-healed" \
  || fail "the healing switch did not return the lister profile"
HEALED_LISTERS="$(profile_rows listers "$SECOND_USER_ID")"
[ "$HEALED_LISTERS" = "1" ] \
  || fail "the healing switch did not leave exactly one lister row (${HEALED_LISTERS} rows)"
pass "an account with no profile rows heals and reports the profile it opened"

# 8c. the partially provisioned state - a user row, a seeker profile, and a
# stored lister role whose lister row is missing - heals on the next request the
# same way: the missing row is opened and answered with.
db_exec "DELETE FROM listers WHERE user_id='${SECOND_USER_ID}';"
db_exec "INSERT INTO seekers (user_id) VALUES ('${SECOND_USER_ID}');"
CODE=$(curl -s -o "$WORK/change-role-partial" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "a partially provisioned account heals on its next request"
grep -q '"ownership":"owner"' "$WORK/change-role-partial" \
  || fail "the partially provisioned account did not answer with the lister profile"
PARTIAL_LISTERS="$(profile_rows listers "$SECOND_USER_ID")"
[ "$PARTIAL_LISTERS" = "1" ] \
  || fail "the partially provisioned account did not regain its lister row (${PARTIAL_LISTERS} rows)"
PARTIAL_SEEKERS="$(profile_rows seekers "$SECOND_USER_ID")"
[ "$PARTIAL_SEEKERS" = "1" ] \
  || fail "the healing switch lost the seeker row the account already had (${PARTIAL_SEEKERS} rows)"
CODE=$(curl -s -o "$WORK/me-partial" -w '%{http_code}' "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "the healed account's /api/users/me"
grep -q '"userProfile":{' "$WORK/me-partial" \
  || fail "the healed account's profile call did not report the lister profile"
pass "a partially provisioned account heals and reports its profile"

# 8d. a legacy account from before registration provisioned profiles has the
# unassigned role and no rows. It picks a side of the market by naming the
# profile it adopts, which opens that row and assigns the role.
db_exec "DELETE FROM seekers WHERE user_id='${SECOND_USER_ID}';"
db_exec "DELETE FROM listers WHERE user_id='${SECOND_USER_ID}';"
db_exec "UPDATE users SET role='user' WHERE id='${SECOND_USER_ID}';"
CODE=$(curl -s -o "$WORK/change-role-unassigned" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/users/change-role?role=seeker" \
  -H "Origin: ${BASE_URL}" \
  -H "Cookie: access_token=${SECOND_ACCESS}")
assert_status "$CODE" 200 "an unassigned account adopts the profile it names"
grep -q "\"userId\":\"${SECOND_USER_ID}\"" "$WORK/change-role-unassigned" \
  || fail "the adoption switch returned another account's profile"
UNASSIGNED_SEEKERS="$(profile_rows seekers "$SECOND_USER_ID")"
UNASSIGNED_LISTERS="$(profile_rows listers "$SECOND_USER_ID")"
[ "$UNASSIGNED_SEEKERS" = "1" ] \
  || fail "an unassigned account did not get the seeking profile it chose (${UNASSIGNED_SEEKERS} rows)"
[ "$UNASSIGNED_LISTERS" = "0" ] \
  || fail "an unassigned account opened an unchosen lister profile (${UNASSIGNED_LISTERS} rows)"
grep -q '"role":"seeker"' <(curl -s "${BASE_URL}/api/users/me" \
  -H "Cookie: access_token=${SECOND_ACCESS}") \
  || fail "the adoption switch did not change the stored role"
pass "an unassigned account adopts the profile it names"

# 8e. an admin has no profile to switch between, and must never be demoted by a
# payload-less switch.
db_exec "UPDATE users SET role='admin' WHERE id='${SECOND_USER_ID}';"
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
