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

const setRole = (id: string, role: string) =>
  query("UPDATE users SET role = ? WHERE id = ?", [role, id]);

const seedSeeker = (id: string, name = "Ada Seeker") =>
  query(`INSERT INTO seekers (user_id, name, date_of_birth, gender) VALUES (?, ?, ?, ?)`, [
    id,
    name,
    946684800000,
    "NB",
  ]);

const seedLister = (id: string) => query("INSERT INTO listers (user_id) VALUES (?)", [id]);

// A freshly registered account: role `user`, and no profile row for any role.
const freshUser = (label: string) => register(`identity-${label}`);

// An account that is actually set up to seek, so it has a role to switch away
// from: a fresh registration is unassigned until a profile makes it one or the
// other.
const seekerUser = (label: string) =>
  Effect.gen(function* () {
    const user = yield* freshUser(label);
    yield* seedSeeker(user.id);
    yield* setRole(user.id, "seeker");
    return user;
  });

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
      const user = yield* seekerUser("with-profile");

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
      const user = yield* seekerUser("switch-to-lister");
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

  // A double click or a retry can ask again while the row is already there: the
  // ask is idempotent instead of a uniqueness failure.
  it.effect("provisions the lister profile idempotently when it already exists", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("idempotent-provision");
      yield* seedLister(user.id);
      yield* setRole(user.id, "seeker");

      const response = yield* changeRole(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(asObject(bodyOf(response)["newProfile"])["userId"], user.id);
      assert.strictEqual(yield* countFor("listers", user.id), 1);

      // Back to seeking, then to listing again through the same existing row.
      yield* setRole(user.id, "seeker");
      const again = yield* changeRole(user);
      assert.strictEqual(again.status, 200, again.body);
      assert.strictEqual(yield* countFor("listers", user.id), 1);
      assert.strictEqual(yield* storedRole(user.id), "lister");
    }),
  );

  it.effect("switches back to seeking when the seeker profile exists", () =>
    Effect.gen(function* () {
      const user = yield* seekerUser("switch-to-seeker");
      assert.strictEqual((yield* changeRole(user)).status, 200);

      const response = yield* changeRole(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(asObject(bodyOf(response)["newProfile"])["name"], "Ada Seeker");
      assert.strictEqual(yield* storedRole(user.id), "seeker");
    }),
  );

  it.effect("refuses to switch to seeking with no seeker profile and changes nothing", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("refused-seeker");
      yield* setRole(user.id, "lister");
      yield* seedLister(user.id);

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
      const after = yield* me(user);
      assert.strictEqual(roleOf(after), "lister");
      assert.strictEqual(profileOf(after)?.["userId"], user.id);
    }),
  );

  // The stale token is the point: the claim inside it still says `user`, so a
  // handler that read the claim would try listing again instead of refusing.
  it.effect("reads the stored role, so a switch is live on the very same token", () =>
    Effect.gen(function* () {
      const user = yield* seekerUser("stale-claim");
      assert.strictEqual(claimedRole(user), "user");

      const switched = yield* changeRole(user);
      assert.strictEqual(switched.status, 200, switched.body);

      // The cookie was not reissued, so this is the same stale claim.
      assert.strictEqual(claimedRole(user), "user");
      assert.strictEqual(roleOf(yield* me(user)), "lister");

      // Reading the stale claim would switch back to listing; the stored role
      // is what drives the switch, and it goes to the seeker profile.
      const back = yield* changeRole(user);
      assert.strictEqual(back.status, 200, back.body);
      assert.strictEqual(asObject(bodyOf(back)["newProfile"])["name"], "Ada Seeker");
      assert.strictEqual(yield* storedRole(user.id), "seeker");
    }),
  );

  // The state the previous switch left behind when it wrote the role and then
  // could not find the profile: a lister role with no lister row.
  it.effect("heals a stored lister role that has no lister row", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("heal-stored-lister");
      yield* setRole(user.id, "lister");
      assert.strictEqual(yield* countFor("listers", user.id), 0);

      const healed = yield* changeRole(user);

      assert.strictEqual(healed.status, 200, healed.body);
      const profile = asObject(bodyOf(healed)["newProfile"]);
      assert.strictEqual(profile["userId"], user.id);
      assert.strictEqual(profile["ownership"], "owner");
      assert.strictEqual(yield* storedRole(user.id), "lister");
      assert.strictEqual(yield* countFor("listers", user.id), 1);

      // `me` now reports the profile the role points at instead of a null.
      const after = yield* me(user);
      assert.strictEqual(roleOf(after), "lister");
      assert.strictEqual(profileOf(after)?.["userId"], user.id);

      // The repaired account is not stuck: with a seeker profile it switches.
      yield* seedSeeker(user.id);
      const switched = yield* changeRole(user);
      assert.strictEqual(switched.status, 200, switched.body);
      assert.strictEqual(yield* storedRole(user.id), "seeker");
    }),
  );

  it.effect("refuses a role switch for an admin and leaves the admin role alone", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("admin-guard");
      yield* setRole(user.id, "admin");

      const refused = yield* changeRole(user);

      assert.strictEqual(refused.status, 403, refused.body);
      assert.strictEqual(bodyOf(refused)["_tag"], "AdminRoleSwitchError");
      assert.strictEqual(yield* storedRole(user.id), "admin");
      assert.strictEqual(yield* countFor("listers", user.id), 0);
      const after = yield* me(user);
      assert.strictEqual(roleOf(after), "admin");
      assert.isNull(profileOf(after));
    }),
  );

  it.effect("refuses a role switch for an unassigned account", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("unassigned-guard");

      const refused = yield* changeRole(user);

      assert.strictEqual(refused.status, 409, refused.body);
      assert.strictEqual(bodyOf(refused)["_tag"], "UnassignedRoleSwitchError");
      assert.strictEqual(yield* storedRole(user.id), "user");
      assert.strictEqual(yield* countFor("listers", user.id), 0);
      assert.strictEqual(yield* countFor("seekers", user.id), 0);
      const after = yield* me(user);
      assert.strictEqual(roleOf(after), "user");
      assert.isNull(profileOf(after));
    }),
  );

  it.effect("rejects an unauthenticated caller with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("POST", "/api/users/change-role");
      assert.strictEqual(response.status, 401);
    }),
  );
});
