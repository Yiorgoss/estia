import { asObject, call, json, query, register, send, testOrigin } from "../support/api";
import type { TestUser } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The signed-in account's own view, driven through the real private router -
 * `AuthMiddleware`, the handler, `UserService`, and the repositories - so a test
 * sees exactly what a browser sees. The database is read through the same
 * in-memory client the handlers use, because several of these rules are about
 * what a request did to a row, not about what a response claimed.
 */

const me = (user: TestUser) =>
  call("/api/users/me", { headers: { cookie: user.cookie, "user-agent": "estia-tests" } });

// A browser posts this from the app's own page, and the switch carries no body:
// everything it needs is the session plus the account's stored state.
const changeRole = (user: TestUser) =>
  call(
    "/api/users/change-role",
    json({
      method: "POST",
      headers: { cookie: user.cookie, origin: testOrigin },
    }),
  );

const bodyOf = (response: { readonly body: string; readonly json: unknown }) => {
  assert.isDefined(response.json, response.body);
  return asObject(response.json);
};

const profileOf = (response: { readonly body: string; readonly json: unknown }) => {
  const profile = bodyOf(response)["userProfile"];
  return profile === null ? null : asObject(profile);
};

const roleOf = (response: { readonly body: string; readonly json: unknown }) =>
  asObject(bodyOf(response)["user"])["role"];

// The claims inside the cookie the test is presenting, so a test can show that a
// role it observes did not come from the token.
const claimedRole = (user: TestUser) => {
  const token = user.cookie.replace("access_token=", "");
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
  return claims.role;
};

const storedRole = (id: string) =>
  Effect.map(
    query<{ role: string }>("SELECT role FROM users WHERE id = ?", [id]),
    (rows) => rows[0]?.role,
  );

const countFor = (table: string, userId: string) =>
  Effect.map(
    query<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`, [userId]),
    (rows) => rows[0]?.total,
  );

// A freshly registered account: role `user`, and no profile row for any role.
const freshUser = (label: string) => register(`identity-${label}`);

describe("GET /api/users/me", () => {
  it.effect("answers honestly with a null profile for a fresh account", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("fresh-me");

      const response = yield* me(user);

      assert.strictEqual(response.status, 200, response.body);
      const body = bodyOf(response);
      assert.deepStrictEqual(Object.keys(body).sort(), ["user", "userProfile"]);
      assert.strictEqual(asObject(body["user"])["id"], user.id);
      assert.strictEqual(body["userProfile"], null);
    }),
  );

  it.effect("still returns the profile the caller's role points at", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("with-profile");

      // Switching to listing provisions the lister row, so this account now has
      // a role and a profile that agree.
      const switched = yield* changeRole(user);
      assert.strictEqual(switched.status, 200, switched.body);

      const response = yield* me(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(roleOf(response), "lister");
      const profile = profileOf(response);
      assert.isNotNull(profile);
      assert.strictEqual(profile["userId"], user.id);
      assert.strictEqual(profile["ownership"], "owner");
    }),
  );

  it.effect("rejects an unauthenticated caller with a 401", () =>
    Effect.gen(function* () {
      const response = yield* call("/api/users/me");
      assert.strictEqual(response.status, 401);
    }),
  );
});

describe("POST /api/users/change-role", () => {
  it.effect("switches to listing by provisioning the lister profile", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("switch-to-lister");
      assert.strictEqual(yield* countFor("listers", user.id), 0);

      const response = yield* changeRole(user);

      assert.strictEqual(response.status, 200, response.body);
      const profile = asObject(bodyOf(response)["newProfile"]);
      assert.strictEqual(profile["userId"], user.id);
      assert.strictEqual(profile["ownership"], "owner");
      assert.isNull(profile["name"]);

      // The role and the row agree, in the database and not just on the wire.
      assert.strictEqual(yield* storedRole(user.id), "lister");
      assert.strictEqual(yield* countFor("listers", user.id), 1);
    }),
  );

  it.effect("switches back to seeking when the seeker profile exists", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("switch-to-seeker");
      assert.strictEqual((yield* changeRole(user)).status, 200);
      yield* query(
        `INSERT INTO seekers (user_id, name, date_of_birth, gender)
         VALUES (?, ?, ?, ?)`,
        [user.id, "Ada Seeker", 946684800000, "NB"],
      );

      const response = yield* changeRole(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(asObject(bodyOf(response)["newProfile"])["name"], "Ada Seeker");
      assert.strictEqual(yield* storedRole(user.id), "seeker");
    }),
  );

  it.effect("refuses to switch to seeking with no seeker profile and changes nothing", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("refused-seeker");
      assert.strictEqual((yield* changeRole(user)).status, 200);
      assert.strictEqual(yield* storedRole(user.id), "lister");

      // The switch a payload-less request cannot complete: a seeker profile
      // needs a name, a date of birth, and a gender, which nobody sent.
      const refused = yield* changeRole(user);

      assert.strictEqual(refused.status, 409, refused.body);
      const body = bodyOf(refused);
      assert.strictEqual(body["_tag"], "SeekerProfileRequiredError");
      assert.include(String(body["message"]), "seeker profile has to be completed first");

      // The account is exactly where it was: no role pointing at nothing, and
      // neither profile table gained a row.
      assert.strictEqual(yield* storedRole(user.id), "lister");
      assert.strictEqual(yield* countFor("seekers", user.id), 0);
      assert.strictEqual(yield* countFor("listers", user.id), 1);
      assert.strictEqual(roleOf(yield* me(user)), "lister");
    }),
  );

  // The stale token is the point: the claim inside it still says `user`, so a
  // handler that read the claim would try listing again instead of refusing.
  it.effect("reads the stored role, so a switch is live on the very same token", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("stale-claim");
      assert.strictEqual(claimedRole(user), "user");

      const switched = yield* changeRole(user);
      assert.strictEqual(switched.status, 200, switched.body);

      // The cookie was not reissued, so this is the same stale claim.
      assert.strictEqual(claimedRole(user), "user");
      assert.strictEqual(roleOf(yield* me(user)), "lister");
      assert.strictEqual(
        (yield* changeRole(user)).status,
        409,
        "the stale claim drove the switch instead of the stored role",
      );
    }),
  );

  it.effect("rejects an unauthenticated caller with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("POST", "/api/users/change-role");
      assert.strictEqual(response.status, 401);
    }),
  );
});
