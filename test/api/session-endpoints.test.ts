import { asObject, call, form, query, send, testOrigin } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { createHash } from "node:crypto";

/*
 * The two ends of a session, driven through the real public router and the real
 * `AuthMiddleware`, so a test sees exactly what a browser or an API client sees.
 * Several of these rules are about what a request did to a refresh-token row, so
 * the database is read through the same in-memory client the handlers use
 * rather than inferred from a later response.
 *
 * Neither route is behind the auth middleware on purpose: logout keys on the
 * refresh token, which outlives the access token by a month, and refresh exists
 * precisely because the access token has run out.
 */

const PASSWORD = "correct horse battery staple";

interface Session {
  readonly id: string;
  readonly access: string;
  readonly refresh: string;
}

let sessionCounter = 0;
const uniqueEmail = (label: string) =>
  `session-${label}-${Date.now()}-${(sessionCounter += 1)}@test.local`;

// A real registration, so both cookies are the pair the app actually issues.
const signIn = (label: string): Effect.Effect<Session> =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/auth/register", {
      payload: { email: uniqueEmail(label), password: PASSWORD },
    });
    assert.strictEqual(response.status, 200, response.body);

    const access = response.cookies["access_token"];
    const refresh = response.cookies["refresh_token"];
    assert.isString(access);
    assert.isString(refresh);
    const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
    return { id: String(claims.id), access, refresh };
  });

const bothCookies = (session: Session) =>
  `access_token=${session.access}; refresh_token=${session.refresh}`;

// The refresh-token rows are keyed by the token's hash, never by the token, so a
// test has to hash the value it presents to name the row the app is about to
// touch.
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

interface TokenRow {
  readonly revokedAt: number | null;
  readonly expiresAt: number;
  readonly userId: string;
}

const tokenRow = (token: string) =>
  Effect.map(
    query<TokenRow>(
      "SELECT revoked_at AS revokedAt, expires_at AS expiresAt, user_id AS userId FROM refresh_tokens WHERE token_hash = ?",
      [hashOf(token)],
    ),
    (rows) => rows[0],
  );

const expireToken = (token: string) =>
  query("UPDATE refresh_tokens SET expires_at = ? WHERE token_hash = ?", [1, hashOf(token)]);

const headerNamed = (setCookies: ReadonlyArray<string>, name: string) =>
  setCookies.find((header) => header.toLowerCase().startsWith(`${name}=`));

const assertClearedCookie = (setCookies: ReadonlyArray<string>, name: string) => {
  const header = headerNamed(setCookies, name);
  assert.isDefined(header, `${name} was not cleared: ${setCookies.join(" | ")}`);
  // A cleared cookie is the issued cookie with nothing left in it, so a browser
  // drops it: empty value, no lifetime, and the same path and flags it was
  // written with. A mismatched path or flag would leave the old one in place.
  assert.match(header ?? "", new RegExp(`^${name}=;`, "i"));
  assert.match(header ?? "", /max-age=0/i);
  assert.match(header ?? "", /path=\//i);
  assert.match(header ?? "", /httponly/i);
  assert.match(header ?? "", /secure/i);
  assert.match(header ?? "", /samesite=lax/i);
};

const assertSessionCookie = (setCookies: ReadonlyArray<string>, name: string) => {
  const header = headerNamed(setCookies, name);
  assert.isDefined(header, `${name} was not set: ${setCookies.join(" | ")}`);
  assert.match(header ?? "", /httponly/i);
  assert.match(header ?? "", /secure/i);
  assert.match(header ?? "", /samesite=lax/i);
  assert.match(header ?? "", /path=\//i);
};

// A JSON client: no page to show, so the answer is an empty 204.
const logout = (session?: Session) =>
  call("/api/auth/logout", {
    method: "POST",
    headers: {
      "user-agent": "estia-tests",
      ...(session === undefined ? {} : { cookie: bothCookies(session) }),
    },
  });

// A browser submitting the form on the profile page.
const browserLogout = (session: Session) =>
  call(
    "/api/auth/logout",
    form(
      {
        method: "POST",
        headers: { cookie: bothCookies(session), accept: "text/html,application/xhtml+xml" },
      },
      {},
    ),
  );

const refreshWith = (refreshToken?: string) =>
  call("/api/auth/refresh", {
    method: "POST",
    headers: {
      "user-agent": "estia-tests",
      ...(refreshToken === undefined ? {} : { cookie: `refresh_token=${refreshToken}` }),
    },
  });

const userOf = (response: { readonly body: string; readonly json: unknown }) =>
  asObject(asObject(response.json)["user"]);

describe("POST /api/auth/logout", () => {
  it.effect("revokes the presented refresh token and clears both session cookies", () =>
    Effect.gen(function* () {
      const session = yield* signIn("revokes");
      assert.isNull((yield* tokenRow(session.refresh))?.revokedAt);

      const response = yield* logout(session);

      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(response.body, "");
      assertClearedCookie(response.setCookies, "access_token");
      assertClearedCookie(response.setCookies, "refresh_token");

      const row = yield* tokenRow(session.refresh);
      assert.isNotNull(row?.revokedAt);
      assert.strictEqual(row?.userId, session.id);
    }),
  );

  // The access token is short-lived and may already have expired; the month-long
  // refresh token is the credential that has to die, so signing out must not
  // depend on a usable access token.
  it.effect("revokes on the refresh token alone when the access token is dead", () =>
    Effect.gen(function* () {
      const session = yield* signIn("expired-access");

      const response = yield* call("/api/auth/logout", {
        method: "POST",
        headers: {
          "user-agent": "estia-tests",
          cookie: `access_token=an.expired.token; refresh_token=${session.refresh}`,
        },
      });

      assert.strictEqual(response.status, 204, response.body);
      assert.isNotNull((yield* tokenRow(session.refresh))?.revokedAt);
      assertClearedCookie(response.setCookies, "refresh_token");
    }),
  );

  it.effect("answers a browser form post with a redirect to the sign-in page", () =>
    Effect.gen(function* () {
      const session = yield* signIn("browser");

      const response = yield* browserLogout(session);

      assert.strictEqual(response.status, 303, response.body);
      assert.strictEqual(response.location, "/login");
      assertClearedCookie(response.setCookies, "access_token");
      assertClearedCookie(response.setCookies, "refresh_token");
      assert.isNotNull((yield* tokenRow(session.refresh))?.revokedAt);
    }),
  );

  it.effect("is harmless for a caller who is already signed out", () =>
    Effect.gen(function* () {
      const response = yield* logout();

      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(response.body, "");
      assertClearedCookie(response.setCookies, "access_token");
      assertClearedCookie(response.setCookies, "refresh_token");
    }),
  );

  it.effect("is harmless when the presented refresh token is not one the app issued", () =>
    Effect.gen(function* () {
      const response = yield* call("/api/auth/logout", {
        method: "POST",
        headers: { "user-agent": "estia-tests", cookie: "refresh_token=not-a-real-token" },
      });

      assert.strictEqual(response.status, 204, response.body);
      assertClearedCookie(response.setCookies, "refresh_token");
    }),
  );

  it.effect("refuses a form post from another site instead of ending the session", () =>
    Effect.gen(function* () {
      const session = yield* signIn("cross-site");

      const response = yield* call(
        "/api/auth/logout",
        form(
          {
            method: "POST",
            headers: {
              cookie: bothCookies(session),
              origin: "https://evil.example",
              accept: "text/html",
            },
          },
          {},
        ),
      );

      assert.strictEqual(response.status, 403, response.body);
      assert.isNull((yield* tokenRow(session.refresh))?.revokedAt);
    }),
  );
});

describe("POST /api/auth/refresh", () => {
  it.effect("returns a fresh cookie pair and the current user for a live token", () =>
    Effect.gen(function* () {
      const session = yield* signIn("refresh");

      const response = yield* refreshWith(session.refresh);

      assert.strictEqual(response.status, 200, response.body);
      const user = userOf(response);
      assert.strictEqual(user["id"], session.id);
      assert.strictEqual(user["role"], "seeker");

      assertSessionCookie(response.setCookies, "access_token");
      assertSessionCookie(response.setCookies, "refresh_token");
      const newRefresh = response.cookies["refresh_token"];
      assert.isString(newRefresh);
      assert.notStrictEqual(newRefresh, session.refresh);
      assert.isString(response.cookies["access_token"]);
    }),
  );

  it.effect("rotates exactly once, so the consumed token cannot be replayed", () =>
    Effect.gen(function* () {
      const session = yield* signIn("replay");

      const first = yield* refreshWith(session.refresh);
      assert.strictEqual(first.status, 200, first.body);
      assert.isNotNull((yield* tokenRow(session.refresh))?.revokedAt);

      const replay = yield* refreshWith(session.refresh);

      assert.strictEqual(replay.status, 401, replay.body);
      assert.deepStrictEqual(replay.setCookies, []);
      assert.strictEqual(replay.body, "UnauthorizedError");
    }),
  );

  it.effect("answers a replay after logout with 401 and sets nothing", () =>
    Effect.gen(function* () {
      const session = yield* signIn("replay-after-logout");
      assert.strictEqual((yield* logout(session)).status, 204);

      const replay = yield* refreshWith(session.refresh);

      assert.strictEqual(replay.status, 401, replay.body);
      assert.deepStrictEqual(replay.setCookies, []);
    }),
  );

  it.effect("answers a garbage token with 401 and sets nothing", () =>
    Effect.gen(function* () {
      const response = yield* refreshWith("not-a-real-token");

      assert.strictEqual(response.status, 401, response.body);
      assert.deepStrictEqual(response.setCookies, []);
      assert.strictEqual(response.body, "UnauthorizedError");
    }),
  );

  it.effect("answers an expired token with 401 and sets nothing", () =>
    Effect.gen(function* () {
      const session = yield* signIn("expired");
      yield* expireToken(session.refresh);

      const response = yield* refreshWith(session.refresh);

      assert.strictEqual(response.status, 401, response.body);
      assert.deepStrictEqual(response.setCookies, []);
    }),
  );

  it.effect("answers a missing cookie with 401 and sets nothing", () =>
    Effect.gen(function* () {
      const response = yield* refreshWith();

      assert.strictEqual(response.status, 401, response.body);
      assert.deepStrictEqual(response.setCookies, []);
    }),
  );

  // The point of the new pair is that it opens private routes: the refresh route
  // issues a usable session, not just two plausible-looking cookies.
  it.effect("issues an access cookie that opens a private route as the same account", () =>
    Effect.gen(function* () {
      const session = yield* signIn("usability");

      const refreshed = yield* refreshWith(session.refresh);
      assert.strictEqual(refreshed.status, 200, refreshed.body);
      const newAccess = refreshed.cookies["access_token"];
      assert.isString(newAccess);

      const me = yield* call("/api/users/me", {
        headers: { cookie: `access_token=${newAccess}`, "user-agent": "estia-tests" },
      });

      assert.strictEqual(me.status, 200, me.body);
      assert.strictEqual(asObject(asObject(me.json)["user"])["id"], session.id);
    }),
  );
});

/*
 * The middleware's post-processing rotation is untouched by the route above: a
 * private request that has only a refresh cookie still gets a new pair on the
 * private response, and a private request with no session at all still gets a
 * 401 with no cookies on it.
 */
describe("the middleware rotation on private requests", () => {
  it.effect("still rotates the refresh token and sets both cookies", () =>
    Effect.gen(function* () {
      const session = yield* signIn("middleware");

      const response = yield* call("/private-get", {
        headers: { cookie: `refresh_token=${session.refresh}`, "user-agent": "estia-tests" },
      });

      assert.strictEqual(response.status, 200, response.body);
      assertSessionCookie(response.setCookies, "access_token");
      assertSessionCookie(response.setCookies, "refresh_token");
      const rotated = response.cookies["refresh_token"];
      assert.isString(rotated);
      assert.notStrictEqual(rotated, session.refresh);
      assert.isNotNull((yield* tokenRow(session.refresh))?.revokedAt);
      // The middleware still uses the access token it is given, so the pair it
      // answered with is live rather than a second rotation path.
      assert.isNull((yield* tokenRow(String(rotated)))?.revokedAt);
    }),
  );

  it.effect("still answers a signed-out private request with 401 and no cookies", () =>
    Effect.gen(function* () {
      const response = yield* call("/private-get", {
        headers: { "user-agent": "estia-tests" },
      });

      assert.strictEqual(response.status, 401, response.body);
      assert.deepStrictEqual(response.setCookies, []);
    }),
  );

  it.effect("still answers a page request with the sign-in prompt", () =>
    Effect.gen(function* () {
      const response = yield* call("/profile", {
        headers: { "user-agent": "estia-tests", accept: "text/html" },
      });

      assert.strictEqual(response.status, 401, response.body);
      assert.include(response.body, "Sign in required");
    }),
  );
});

// A form post from another site can reach a state-changing route with the cookie
// attached, so both routes are covered by the same origin rule as every other
// write: a foreign page cannot log the person out or rotate their refresh token.
// The cookie attribute `SameSite=Lax` is the other half of that defence.
describe("cross-site posts to the session routes", () => {
  it.effect("cannot replay or rotate a refresh token from another site", () =>
    Effect.gen(function* () {
      const session = yield* signIn("cross-site-refresh");

      const response = yield* call(
        "/api/auth/refresh",
        form(
          {
            method: "POST",
            headers: { cookie: `refresh_token=${session.refresh}`, origin: "https://evil.example" },
          },
          {},
        ),
      );

      assert.strictEqual(response.status, 403, response.body);
      assert.deepStrictEqual(response.setCookies, []);
      // The token is untouched, so the person's own refresh still works.
      assert.isNull((yield* tokenRow(session.refresh))?.revokedAt);
      assert.strictEqual((yield* refreshWith(session.refresh)).status, 200);
    }),
  );

  it.effect("from the app's own origin is allowed through", () =>
    Effect.gen(function* () {
      const session = yield* signIn("origin-refresh");

      const response = yield* call(
        "/api/auth/refresh",
        form(
          {
            method: "POST",
            headers: { cookie: `refresh_token=${session.refresh}`, origin: testOrigin },
          },
          {},
        ),
      );

      assert.strictEqual(response.status, 200, response.body);
      assertSessionCookie(response.setCookies, "refresh_token");
    }),
  );
});
