import { asObject, call, form, query, send, testOrigin } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { createHash } from "node:crypto";

/*
 * The ends of a session, and a deliberate renewal, driven through the real
 * public router and the real `AuthMiddleware`, so a test sees exactly what a
 * browser or an API client sees. Several of these rules are about what a request
 * did to a refresh-token row, so the database is read through the same in-memory
 * client the handlers use rather than inferred from a later response.
 *
 * None of these routes is behind the auth middleware on purpose: logout keys on
 * the refresh token, which outlives the access token by a month, refresh exists
 * precisely because the access token has run out, and signing out of every
 * device is identified by the same cookie pair.
 */

const PASSWORD = "correct horse battery staple";

interface Session {
  readonly id: string;
  readonly email: string;
  readonly access: string;
  readonly refresh: string;
}

let sessionCounter = 0;
const uniqueEmail = (label: string) =>
  `session-${label}-${Date.now()}-${(sessionCounter += 1)}@test.local`;

// Both session-opening routes answer with the cookie pair the app actually
// issues, so the tests read the session from the response, never from a guess.
const sessionFrom = (
  response: { readonly cookies: Readonly<Record<string, string>>; readonly status: number },
  email: string,
): Session => {
  assert.strictEqual(response.status, 200, `sign in ${email}`);
  const access = response.cookies["access_token"];
  const refresh = response.cookies["refresh_token"];
  assert.isString(access);
  assert.isString(refresh);
  const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
  return { id: String(claims.id), email, access, refresh };
};

// A real registration, so both cookies are the pair the app actually issues.
const signIn = (label: string): Effect.Effect<Session> =>
  Effect.gen(function* () {
    const email = uniqueEmail(label);
    const response = yield* send("POST", "/api/auth/register", {
      payload: { email, password: PASSWORD },
    });
    return sessionFrom(response, email);
  });

// The same account signing in again, which is what another device, or a second
// visit later, does. Every sign-in gets its own refresh token.
const logIn = (email: string): Effect.Effect<Session> =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/auth/login", {
      payload: { email, password: PASSWORD },
    });
    return sessionFrom(response, email);
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

const liveTokenCount = (userId: string) =>
  Effect.map(
    query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    ),
    (rows) => rows[0]?.total ?? 0,
  );

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

// The all-devices action, driven the same two ways: a JSON client, and a browser
// posting the control on the profile page.
const logoutEverywhere = (session?: Session) =>
  call("/api/auth/logout-all", {
    method: "POST",
    headers: {
      "user-agent": "estia-tests",
      ...(session === undefined ? {} : { cookie: bothCookies(session) }),
    },
  });

const browserLogoutEverywhere = (session: Session) =>
  call(
    "/api/auth/logout-all",
    form(
      {
        method: "POST",
        headers: {
          cookie: bothCookies(session),
          accept: "text/html,application/xhtml+xml",
        },
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

describe("POST /api/auth/logout-all", () => {
  // Signing out of every device means every session the account has: another
  // device's sign-in, and the sessions earlier visits left behind, die with the
  // one performing the action.
  it.effect("revokes every outstanding refresh token the account has", () =>
    Effect.gen(function* () {
      const first = yield* signIn("everywhere");
      const second = yield* logIn(first.email);
      const third = yield* logIn(first.email);
      assert.strictEqual(yield* liveTokenCount(first.id), 3);

      const response = yield* logoutEverywhere(first);

      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(response.body, "");
      assertClearedCookie(response.setCookies, "access_token");
      assertClearedCookie(response.setCookies, "refresh_token");

      for (const token of [first.refresh, second.refresh, third.refresh]) {
        assert.isNotNull((yield* tokenRow(token))?.revokedAt);
      }
      assert.strictEqual(yield* liveTokenCount(first.id), 0);
    }),
  );

  // The token each session holds is revoked, not merely forgotten by the one
  // device that asked: replaying any of them is a 401 with no cookies on it.
  it.effect("answers a replay of any revoked refresh token with 401", () =>
    Effect.gen(function* () {
      const first = yield* signIn("everywhere-replay");
      const second = yield* logIn(first.email);
      assert.strictEqual((yield* logoutEverywhere(first)).status, 204);

      for (const token of [first.refresh, second.refresh]) {
        const replay = yield* refreshWith(token);
        assert.strictEqual(replay.status, 401, replay.body);
        assert.strictEqual(replay.body, "UnauthorizedError");
        assert.deepStrictEqual(replay.setCookies, []);
      }
    }),
  );

  // Ending every session of one account says nothing about any other account.
  it.effect("leaves another account's sessions alone", () =>
    Effect.gen(function* () {
      const owner = yield* signIn("everywhere-owner");
      const ownerSecondDevice = yield* logIn(owner.email);
      const bystander = yield* signIn("everywhere-bystander");

      assert.strictEqual((yield* logoutEverywhere(owner)).status, 204);

      assert.strictEqual(yield* liveTokenCount(owner.id), 0);
      assert.isNotNull((yield* tokenRow(ownerSecondDevice.refresh))?.revokedAt);
      assert.strictEqual(yield* liveTokenCount(bystander.id), 1);
      const stillLive = yield* refreshWith(bystander.refresh);
      assert.strictEqual(stillLive.status, 200, stillLive.body);
    }),
  );

  // The caller lands signed out of this device too: both cookies are cleared and
  // the session it was using cannot be replayed.
  it.effect("signs the calling device out as part of the action", () =>
    Effect.gen(function* () {
      const session = yield* signIn("everywhere-this-device");

      const response = yield* logoutEverywhere(session);

      assert.strictEqual(response.status, 204, response.body);
      assertClearedCookie(response.setCookies, "access_token");
      assertClearedCookie(response.setCookies, "refresh_token");
      assert.isNotNull((yield* tokenRow(session.refresh))?.revokedAt);
      assert.strictEqual((yield* refreshWith(session.refresh)).status, 401);
    }),
  );

  it.effect("answers a browser form post with a redirect to the sign-in page", () =>
    Effect.gen(function* () {
      const session = yield* signIn("everywhere-browser");
      const second = yield* logIn(session.email);

      const response = yield* browserLogoutEverywhere(session);

      assert.strictEqual(response.status, 303, response.body);
      assert.strictEqual(response.location, "/login");
      assertClearedCookie(response.setCookies, "access_token");
      assertClearedCookie(response.setCookies, "refresh_token");
      assert.isNotNull((yield* tokenRow(second.refresh))?.revokedAt);
      assert.strictEqual(yield* liveTokenCount(session.id), 0);
    }),
  );

  // The access cookie may already have expired by the time the control is
  // clicked. A live refresh token identifies the account on its own.
  it.effect("ends every session when only the refresh cookie is presented", () =>
    Effect.gen(function* () {
      const session = yield* signIn("everywhere-refresh-only");
      const second = yield* logIn(session.email);

      const response = yield* call("/api/auth/logout-all", {
        method: "POST",
        headers: {
          "user-agent": "estia-tests",
          cookie: `refresh_token=${session.refresh}`,
        },
      });

      assert.strictEqual(response.status, 204, response.body);
      assert.isNotNull((yield* tokenRow(session.refresh))?.revokedAt);
      assert.isNotNull((yield* tokenRow(second.refresh))?.revokedAt);
    }),
  );

  // A browser that lost its refresh cookie while its access cookie is still
  // live is still signed in on this device, so the action can still find the
  // account and end its sessions.
  it.effect("ends every session when only the access cookie is presented", () =>
    Effect.gen(function* () {
      const session = yield* signIn("everywhere-access-only");
      const second = yield* logIn(session.email);

      const response = yield* call("/api/auth/logout-all", {
        method: "POST",
        headers: { "user-agent": "estia-tests", cookie: `access_token=${session.access}` },
      });

      assert.strictEqual(response.status, 204, response.body);
      assertClearedCookie(response.setCookies, "refresh_token");
      assert.isNotNull((yield* tokenRow(session.refresh))?.revokedAt);
      assert.isNotNull((yield* tokenRow(second.refresh))?.revokedAt);
    }),
  );

  // What the action honestly cannot reach, pinned so the profile page's copy
  // cannot promise more than the app does: there is no revocation list for the
  // access tokens already issued, so one keeps opening private routes until it
  // expires, within an hour.
  it.effect("cannot recall an access token that was already issued", () =>
    Effect.gen(function* () {
      const session = yield* signIn("everywhere-access-token");

      assert.strictEqual((yield* logoutEverywhere(session)).status, 204);

      const me = yield* call("/api/users/me", {
        headers: { cookie: `access_token=${session.access}`, "user-agent": "estia-tests" },
      });
      assert.strictEqual(me.status, 200, me.body);
      assert.strictEqual(asObject(asObject(me.json)["user"])["id"], session.id);
    }),
  );

  it.effect("is harmless for a caller who is already signed out", () =>
    Effect.gen(function* () {
      const response = yield* logoutEverywhere();

      assert.strictEqual(response.status, 204, response.body);
      assert.strictEqual(response.body, "");
      assertClearedCookie(response.setCookies, "access_token");
      assertClearedCookie(response.setCookies, "refresh_token");
    }),
  );

  // The success answers above promise that the sessions on the other devices
  // are over. When the database refuses the revocation they are not, so the
  // route has to answer an error - while still signing this device out - rather
  // than redirecting to the sign-in page or answering 204 as if it had.
  it.effect("answers a refused revocation with an error and still signs this device out", () =>
    Effect.gen(function* () {
      const session = yield* signIn("everywhere-revocation-refused");
      const second = yield* logIn(session.email);

      const withRefusedRevocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          yield* query(
            `CREATE TRIGGER logout_all_revocation_refused
               BEFORE UPDATE ON refresh_tokens
             BEGIN
               SELECT RAISE(ABORT, 'revocation unavailable');
             END`,
          );
          return yield* effect;
        }).pipe(Effect.ensuring(query("DROP TRIGGER IF EXISTS logout_all_revocation_refused")));

      const jsonResponse = yield* withRefusedRevocation(logoutEverywhere(session));
      assert.strictEqual(jsonResponse.status, 500, jsonResponse.body);
      assert.strictEqual(jsonResponse.location, null);
      assertClearedCookie(jsonResponse.setCookies, "access_token");
      assertClearedCookie(jsonResponse.setCookies, "refresh_token");

      const htmlResponse = yield* withRefusedRevocation(browserLogoutEverywhere(session));
      assert.strictEqual(htmlResponse.status, 500, htmlResponse.body);
      assert.strictEqual(htmlResponse.location, null);
      assertClearedCookie(htmlResponse.setCookies, "access_token");
      assertClearedCookie(htmlResponse.setCookies, "refresh_token");

      // The cookies are gone, so a bare retry would name no account and be
      // answered as a success while the other devices stayed signed in. The
      // message has to say so and point at signing in again instead.
      for (const response of [jsonResponse, htmlResponse]) {
        assert.include(response.body, "did not complete on our side");
        assert.include(response.body, "other devices may still be signed in");
        assert.include(response.body, "Sign in again and repeat the action");
        assert.notInclude(response.body.toLowerCase(), "try again");
      }

      // The refusal was real: neither this device's token nor the other
      // device's token was revoked, so the 500 is not a false alarm.
      assert.isNull((yield* tokenRow(session.refresh))?.revokedAt);
      assert.isNull((yield* tokenRow(second.refresh))?.revokedAt);
    }),
  );

  // Ending every session is a write, so a page on another site cannot post it
  // with the session attached.
  it.effect("refuses a form post from another site instead of ending the sessions", () =>
    Effect.gen(function* () {
      const session = yield* signIn("everywhere-cross-site");
      const second = yield* logIn(session.email);

      const response = yield* call(
        "/api/auth/logout-all",
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
      assert.isNull((yield* tokenRow(second.refresh))?.revokedAt);
      assert.strictEqual(yield* liveTokenCount(session.id), 2);
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
