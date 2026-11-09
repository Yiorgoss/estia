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

// A browser posts this from the app's own page, and a switch on an assigned
// account carries no query: everything it needs is the session plus the account's
// stored state. An unassigned account names the role it adopts.
const changeRole = (user: TestUser, role?: "seeker" | "lister") =>
  call(
    `/api/users/change-role${role === undefined ? "" : `?role=${role}`}`,
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

// The fields a person fills in themselves. Registration opened the row, so the
// test completes it the way the profile page eventually will.
const nameSeeker = (id: string, name = "Ada Seeker") =>
  query("UPDATE seekers SET name = ?, date_of_birth = ?, gender = ? WHERE user_id = ?", [
    name,
    946684800000,
    "NB",
    id,
  ]);

const deleteProfile = (table: "seekers" | "listers", id: string) =>
  query(`DELETE FROM ${table} WHERE user_id = ?`, [id]);

// A freshly registered account: role `seeker`, and one row in each profile table.
const freshUser = (label: string) => register(`identity-${label}`);

// An account from before registration provisioned both profiles: the user row
// exists, and the role is whatever it was left as while neither profile table
// has a row for it. It is built from a real registration so the row has the
// shape the app creates, then stripped back to the legacy state.
const legacyUser = (label: string, role: "user" | "seeker" | "lister" | "admin") =>
  Effect.gen(function* () {
    const user = yield* freshUser(label);
    yield* deleteProfile("seekers", user.id);
    yield* deleteProfile("listers", user.id);
    yield* setRole(user.id, role);
    return user;
  });

describe("POST /api/auth/register", () => {
  it.effect("opens one seeking and one listing profile for the new account", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("register-provisions");

      assert.strictEqual(yield* countFor("seekers", user.id), 1);
      assert.strictEqual(yield* countFor("listers", user.id), 1);
      assert.strictEqual(yield* storedRole(user.id), "seeker");

      // The seeking row is a real row nobody has filled in yet, not a placeholder
      // that pretends to be a person.
      const rows = yield* query<{ name: string | null; dateOfBirth: number | null }>(
        "SELECT name, date_of_birth AS dateOfBirth, gender FROM seekers WHERE user_id = ?",
        [user.id],
      );
      assert.strictEqual(rows.length, 1);
      assert.isNull(rows[0]?.name);
      assert.isNull(rows[0]?.dateOfBirth);
    }),
  );

  it.effect("answers the same empty 200 with the same two session cookies", () =>
    Effect.gen(function* () {
      const email = `identity-answer-${Date.now()}@test.local`;
      const response = yield* send("POST", "/api/auth/register", {
        payload: { email, password: "correct horse battery staple" },
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, "");
      assert.deepStrictEqual(Object.keys(response.cookies).sort(), [
        "access_token",
        "refresh_token",
      ]);
    }),
  );
});

describe("GET /api/users/me", () => {
  it.effect("answers with the profile the registered role points at", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("fresh-me");

      const response = yield* me(user);

      assert.strictEqual(response.status, 200, response.body);
      const body = bodyOf(response);
      assert.deepStrictEqual(Object.keys(body).sort(), ["user", "userProfile"]);
      assert.strictEqual(asObject(body["user"])["id"], user.id);
      assert.strictEqual(roleOf(response), "seeker");
      // The blank profile registration opened: it exists, and says so honestly by
      // carrying nulls for the fields the person has not filled in.
      const profile = profileOf(response);
      assert.isNotNull(profile);
      assert.strictEqual(profile["userId"], user.id);
      assert.isNull(profile["name"]);
      assert.isNull(profile["dateOfBirth"]);
    }),
  );

  it.effect("returns the profile the caller's role points at", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("with-profile");
      yield* nameSeeker(user.id);

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
  it.effect("switches a fresh account between both roles without provisioning", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("switch-both-ways");
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
      assert.strictEqual(yield* countFor("listers", user.id), 1);

      // Registration already opened both rows, so this is a plain flip to the
      // profile that was there all along.
      const toListing = yield* changeRole(user);

      assert.strictEqual(toListing.status, 200, toListing.body);
      const lister = asObject(bodyOf(toListing)["newProfile"]);
      assert.strictEqual(lister["userId"], user.id);
      assert.strictEqual(lister["ownership"], "owner");
      assert.strictEqual(yield* storedRole(user.id), "lister");
      const listingView = yield* me(user);
      assert.strictEqual(roleOf(listingView), "lister");
      assert.strictEqual(profileOf(listingView)?.["ownership"], "owner");

      const toSeeking = yield* changeRole(user);

      assert.strictEqual(toSeeking.status, 200, toSeeking.body);
      const seeker = asObject(bodyOf(toSeeking)["newProfile"]);
      assert.strictEqual(seeker["userId"], user.id);
      assert.isNull(seeker["name"]);
      assert.strictEqual(yield* storedRole(user.id), "seeker");
      const seekingView = yield* me(user);
      assert.strictEqual(roleOf(seekingView), "seeker");
      assert.strictEqual(profileOf(seekingView)?.["userId"], user.id);

      // Switching is not a provisioning event: the profile tables still hold
      // exactly the one row each that registration created.
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
      assert.strictEqual(yield* countFor("listers", user.id), 1);
    }),
  );

  // The state a pre-provisioning account is in when one of its rows was never
  // opened: exactly one of the two rows exists. The switch heals what it needs
  // and still answers.
  it.effect("heals a partially provisioned account in either direction", () =>
    Effect.gen(function* () {
      const onlyLister = yield* freshUser("partial-lister");
      yield* deleteProfile("seekers", onlyLister.id);
      assert.strictEqual(yield* countFor("seekers", onlyLister.id), 0);

      // Seeking is the stored role and its row is missing, so the flip to
      // listing finds the row that is there and keeps the account honest.
      const toListing = yield* changeRole(onlyLister);
      assert.strictEqual(toListing.status, 200, toListing.body);
      assert.strictEqual(yield* storedRole(onlyLister.id), "lister");
      assert.strictEqual(yield* countFor("listers", onlyLister.id), 1);

      // Coming back opens the missing seeking row instead of refusing: 0006 made
      // the fields optional, so a blank profile can exist.
      const toSeeking = yield* changeRole(onlyLister);
      assert.strictEqual(toSeeking.status, 200, toSeeking.body);
      assert.strictEqual(asObject(bodyOf(toSeeking)["newProfile"])["userId"], onlyLister.id);
      assert.strictEqual(yield* storedRole(onlyLister.id), "seeker");
      assert.strictEqual(yield* countFor("seekers", onlyLister.id), 1);

      const onlySeeker = yield* freshUser("partial-seeker");
      yield* deleteProfile("listers", onlySeeker.id);
      assert.strictEqual(yield* countFor("listers", onlySeeker.id), 0);

      const healed = yield* changeRole(onlySeeker);
      assert.strictEqual(healed.status, 200, healed.body);
      assert.strictEqual(asObject(bodyOf(healed)["newProfile"])["ownership"], "owner");
      assert.strictEqual(yield* storedRole(onlySeeker.id), "lister");
      assert.strictEqual(yield* countFor("listers", onlySeeker.id), 1);
    }),
  );

  // The state the previous switch left behind when it wrote the role and then
  // could not find the profile: a lister role with no lister row.
  it.effect("heals a stored lister role that has no lister row", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("heal-stored-lister", "lister");

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

      // The repaired account is not stuck: the next switch opens the seeking
      // profile it never had and answers with it.
      const switched = yield* changeRole(user);
      assert.strictEqual(switched.status, 200, switched.body);
      assert.strictEqual(asObject(bodyOf(switched)["newProfile"])["userId"], user.id);
      assert.strictEqual(yield* storedRole(user.id), "seeker");
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
    }),
  );

  // A pre-provisioning account that was already seeking has neither row, and
  // still has to be able to switch.
  it.effect("heals a stored seeker role that has no profile rows", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("heal-stored-seeker", "seeker");
      assert.strictEqual(yield* countFor("seekers", user.id), 0);
      assert.strictEqual(yield* countFor("listers", user.id), 0);

      const switched = yield* changeRole(user);

      assert.strictEqual(switched.status, 200, switched.body);
      assert.strictEqual(asObject(bodyOf(switched)["newProfile"])["userId"], user.id);
      assert.strictEqual(yield* storedRole(user.id), "lister");
      assert.strictEqual(yield* countFor("listers", user.id), 1);
    }),
  );

  it.effect("provisions the lister profile idempotently when it already exists", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("idempotent-provision");
      yield* setRole(user.id, "seeker");
      assert.strictEqual(yield* countFor("listers", user.id), 1);

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

  // The stale token is the point: the claim inside it still says `seeker` while
  // the stored role says lister, so a handler that read the claim would flip to
  // listing again instead of seeking.
  it.effect("reads the stored role, so a switch is live on the very same token", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("stale-claim");
      assert.strictEqual(claimedRole(user), "seeker");
      yield* setRole(user.id, "lister");

      const response = yield* changeRole(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(asObject(bodyOf(response)["newProfile"])["userId"], user.id);
      assert.strictEqual(yield* storedRole(user.id), "seeker");

      // The cookie was not reissued, so this is the same stale claim.
      assert.strictEqual(claimedRole(user), "seeker");
      assert.strictEqual(roleOf(yield* me(user)), "seeker");
    }),
  );

  // A named role is honoured even when the account already holds one, so the
  // switch answers with the profile it was asked for instead of flipping.
  it.effect("sets the role an assigned account names", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("named-role");

      const switched = yield* changeRole(user, "seeker");

      assert.strictEqual(switched.status, 200, switched.body);
      assert.strictEqual(asObject(bodyOf(switched)["newProfile"])["userId"], user.id);
      assert.strictEqual(yield* storedRole(user.id), "seeker");
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
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
      assert.strictEqual(roleOf(yield* me(user)), "admin");
    }),
  );

  it.effect("lets an unassigned legacy account adopt seeking", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("adopt-seeker", "user");

      const adopted = yield* changeRole(user, "seeker");

      assert.strictEqual(adopted.status, 200, adopted.body);
      assert.strictEqual(asObject(bodyOf(adopted)["newProfile"])["userId"], user.id);
      assert.strictEqual(yield* storedRole(user.id), "seeker");
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
      assert.strictEqual(yield* countFor("listers", user.id), 0);

      const after = yield* me(user);
      assert.strictEqual(roleOf(after), "seeker");
    }),
  );

  it.effect("lets an unassigned legacy account adopt listing", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("adopt-lister", "user");

      const adopted = yield* changeRole(user, "lister");

      assert.strictEqual(adopted.status, 200, adopted.body);
      assert.strictEqual(asObject(bodyOf(adopted)["newProfile"])["userId"], user.id);
      assert.strictEqual(asObject(bodyOf(adopted)["newProfile"])["ownership"], "owner");
      assert.strictEqual(yield* storedRole(user.id), "lister");
      assert.strictEqual(yield* countFor("listers", user.id), 1);
      assert.strictEqual(yield* countFor("seekers", user.id), 0);

      const after = yield* me(user);
      assert.strictEqual(roleOf(after), "lister");
    }),
  );

  // With no current role and no named choice there is nothing to infer, so the
  // switch is refused instead of guessing a side of the market.
  it.effect("refuses an unassigned legacy account that names no role", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("unassigned-no-choice", "user");

      const refused = yield* changeRole(user);

      assert.strictEqual(refused.status, 409, refused.body);
      assert.strictEqual(bodyOf(refused)["_tag"], "UnassignedRoleSwitchError");
      assert.strictEqual(yield* storedRole(user.id), "user");
      assert.strictEqual(yield* countFor("listers", user.id), 0);
      assert.strictEqual(yield* countFor("seekers", user.id), 0);
    }),
  );

  it.effect("rejects an unauthenticated caller with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("POST", "/api/users/change-role");
      assert.strictEqual(response.status, 401);
    }),
  );
});
