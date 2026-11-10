import { asObject, call, json, query, register, send } from "../support/api";
import type { TestUser } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The caller's own profile, driven through the real private router - the session
 * middleware, the handlers, `UserService`, and the repositories - so a test sees
 * exactly what a browser or an API client sees. The database is read through the
 * same in-memory client the handlers use, because several of these rules are
 * about what a request did to a row, not about what a response claimed.
 */

const profile = (user: TestUser) =>
  call("/api/users/profile", { headers: { cookie: user.cookie, "user-agent": "estia-tests" } });

const saveProfile = (user: TestUser, payload: unknown) =>
  send("PUT", "/api/users/profile", { cookie: user.cookie, payload });

const changeRole = (user: TestUser) =>
  call(
    "/api/users/change-role",
    json({
      method: "POST",
      headers: { cookie: user.cookie, origin: "http://localhost" },
    }),
  );

const bodyOf = (response: { readonly body: string; readonly json: unknown }) => {
  assert.isDefined(response.json, response.body);
  return asObject(response.json);
};

const profileOf = (response: { readonly body: string; readonly json: unknown }) => {
  const value = bodyOf(response)["profile"];
  return value === null ? null : asObject(value);
};

const roleOf = (response: { readonly body: string; readonly json: unknown }) =>
  bodyOf(response)["role"];

const countFor = (table: "seekers" | "listers", userId: string) =>
  Effect.map(
    query<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`, [userId]),
    (rows) => rows[0]?.total,
  );

const deleteProfile = (table: "seekers" | "listers", userId: string) =>
  query(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);

const setRole = (id: string, role: string) =>
  query("UPDATE users SET role = ? WHERE id = ?", [role, id]);

const storedRole = (id: string) =>
  Effect.map(
    query<{ role: string }>("SELECT role FROM users WHERE id = ?", [id]),
    (rows) => rows[0]?.role,
  );

const seekerRow = (userId: string) =>
  Effect.map(
    query<{
      id: number;
      name: string | null;
      bio: string | null;
      dateOfBirth: number | null;
      gender: string | null;
      smoking: number;
      pets: number;
    }>(
      "SELECT id, name, bio, date_of_birth AS dateOfBirth, gender, smoking, pets FROM seekers WHERE user_id = ?",
      [userId],
    ),
    (rows) => rows[0],
  );

const listerRow = (userId: string) =>
  Effect.map(
    query<{ id: number; name: string | null; ownership: string }>(
      "SELECT id, name, ownership FROM listers WHERE user_id = ?",
      [userId],
    ),
    (rows) => rows[0],
  );

const DOB = Date.UTC(1995, 3, 12);

const seekerPayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Ada Seeker",
  dateOfBirth: DOB,
  gender: "female",
  bio: "Looking for a quiet room near the centre",
  smoking: 1,
  pets: 0,
  ...overrides,
});

const listerPayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Ada Lets",
  ownership: "leaseholder",
  ...overrides,
});

// A fresh registration is born seeking, with one row in each profile table.
const freshUser = (label: string) => register(`profile-${label}`);

// An account from before registration provisioned profiles: the unassigned role
// and no profile rows. It picks a side of the market on its first save.
const legacyUser = (label: string) =>
  Effect.gen(function* () {
    const user = yield* freshUser(label);
    yield* deleteProfile("seekers", user.id);
    yield* deleteProfile("listers", user.id);
    yield* setRole(user.id, "user");
    return user;
  });

const listingUser = (label: string) =>
  Effect.gen(function* () {
    const user = yield* freshUser(label);
    const switched = yield* changeRole(user);
    assert.strictEqual(switched.status, 200, switched.body);
    return user;
  });

describe("GET /api/users/profile", () => {
  it.effect("reads the blank seeking profile registration opened", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("read-fresh");

      const response = yield* profile(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(roleOf(response), "seeker");
      const stored = profileOf(response);
      assert.isNotNull(stored);
      assert.strictEqual(stored["userId"], user.id);
      assert.isNull(stored["name"]);
      assert.isNull(stored["dateOfBirth"]);
      assert.isNull(stored["gender"]);
      assert.strictEqual(stored["smoking"], 0);
      assert.strictEqual(stored["pets"], 0);
    }),
  );

  // An account from before registration provisioned profiles has a role and no
  // row. Reading it is an honest null, not an invented profile, so the page can
  // still open the empty form and save into it.
  it.effect("answers a null profile for an account whose row is missing", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("read-missing");
      yield* deleteProfile("seekers", user.id);

      const response = yield* profile(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(roleOf(response), "seeker");
      assert.isNull(profileOf(response));
      assert.strictEqual(yield* countFor("seekers", user.id), 0);
    }),
  );

  it.effect("rejects an unauthenticated caller with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("GET", "/api/users/profile");
      assert.strictEqual(response.status, 401);
    }),
  );

  // A legacy unassigned account has no current role, so it reads as a null
  // profile rather than a refusal. The page asks it to pick one.
  it.effect("answers an unassigned legacy account with a null profile", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("read-unassigned");

      const response = yield* profile(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(roleOf(response), "user");
      assert.isNull(profileOf(response));
    }),
  );

  it.effect("refuses an admin account that holds no profile", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("read-admin");
      yield* deleteProfile("seekers", user.id);
      yield* setRole(user.id, "admin");

      const response = yield* profile(user);

      assert.strictEqual(response.status, 409, response.body);
      assert.strictEqual(bodyOf(response)["_tag"], "ProfileUnavailableError");
    }),
  );
});

describe("PUT /api/users/profile", () => {
  it.effect("saves a seeking profile and reads the stored values back", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("save-seeker");

      const saved = yield* saveProfile(user, seekerPayload());

      assert.strictEqual(saved.status, 200, saved.body);
      assert.strictEqual(roleOf(saved), "seeker");
      const stored = profileOf(saved);
      assert.isNotNull(stored);
      assert.strictEqual(stored["userId"], user.id);
      assert.strictEqual(stored["name"], "Ada Seeker");
      assert.strictEqual(stored["bio"], "Looking for a quiet room near the centre");
      assert.strictEqual(stored["gender"], "female");
      assert.strictEqual(stored["dateOfBirth"], DOB);
      assert.strictEqual(stored["smoking"], 1);
      assert.strictEqual(stored["pets"], 0);

      // The read reports what was stored, and the row is the registration one
      // updated in place rather than a second profile.
      const read = yield* profile(user);
      assert.strictEqual(read.status, 200, read.body);
      assert.strictEqual(profileOf(read)?.["name"], "Ada Seeker");
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
      const row = yield* seekerRow(user.id);
      assert.strictEqual(row?.name, "Ada Seeker");
      assert.strictEqual(row?.dateOfBirth, DOB);
      assert.strictEqual(row?.gender, "female");
    }),
  );

  it.effect("trims a padded name and stores an emptied bio as null", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("save-trim");

      yield* saveProfile(user, seekerPayload({ name: "  Ada Seeker  " }));
      yield* saveProfile(user, seekerPayload({ bio: "   " }));

      const row = yield* seekerRow(user.id);
      assert.strictEqual(row?.name, "Ada Seeker");
      assert.isNull(row?.bio);
    }),
  );

  it.effect("saves a listing profile for an account that is listing", () =>
    Effect.gen(function* () {
      const user = yield* listingUser("save-lister");

      const saved = yield* saveProfile(user, listerPayload());

      assert.strictEqual(saved.status, 200, saved.body);
      assert.strictEqual(roleOf(saved), "lister");
      assert.strictEqual(profileOf(saved)?.["name"], "Ada Lets");
      assert.strictEqual(profileOf(saved)?.["ownership"], "leaseholder");

      const read = yield* profile(user);
      assert.strictEqual(roleOf(read), "lister");
      assert.strictEqual(profileOf(read)?.["ownership"], "leaseholder");
      assert.strictEqual(yield* countFor("listers", user.id), 1);
      const row = yield* listerRow(user.id);
      assert.strictEqual(row?.name, "Ada Lets");
      assert.strictEqual(row?.ownership, "leaseholder");
    }),
  );

  it.effect("lets a listing account save a profile with no display name", () =>
    Effect.gen(function* () {
      const user = yield* listingUser("save-lister-nameless");

      const saved = yield* saveProfile(user, { ownership: "owner" });

      assert.strictEqual(saved.status, 200, saved.body);
      assert.isNull(profileOf(saved)?.["name"]);
      assert.strictEqual(profileOf(saved)?.["ownership"], "owner");
    }),
  );

  it.effect("repairs a missing seeking row by opening it with the submitted details", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("upsert-seeker");
      yield* deleteProfile("seekers", user.id);
      assert.strictEqual(yield* countFor("seekers", user.id), 0);

      const saved = yield* saveProfile(user, seekerPayload());

      assert.strictEqual(saved.status, 200, saved.body);
      assert.strictEqual(profileOf(saved)?.["name"], "Ada Seeker");
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
      assert.strictEqual((yield* seekerRow(user.id))?.gender, "female");
    }),
  );

  it.effect("repairs a missing listing row by opening it with the submitted details", () =>
    Effect.gen(function* () {
      const user = yield* listingUser("upsert-lister");
      yield* deleteProfile("listers", user.id);
      assert.strictEqual(yield* countFor("listers", user.id), 0);

      const saved = yield* saveProfile(user, listerPayload());

      assert.strictEqual(saved.status, 200, saved.body);
      assert.strictEqual(profileOf(saved)?.["ownership"], "leaseholder");
      assert.strictEqual(yield* countFor("listers", user.id), 1);
      assert.strictEqual((yield* listerRow(user.id))?.name, "Ada Lets");
    }),
  );

  it.effect("lets an unassigned legacy account adopt the seeking profile it saves", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("save-legacy-seeker");

      const saved = yield* saveProfile(user, seekerPayload());

      assert.strictEqual(saved.status, 200, saved.body);
      assert.strictEqual(roleOf(saved), "seeker");
      assert.strictEqual(profileOf(saved)?.["name"], "Ada Seeker");
      assert.strictEqual(yield* storedRole(user.id), "seeker");
      assert.strictEqual(yield* countFor("seekers", user.id), 1);
      assert.strictEqual(yield* countFor("listers", user.id), 0);

      const read = yield* profile(user);
      assert.strictEqual(read.status, 200, read.body);
      assert.strictEqual(roleOf(read), "seeker");
      assert.strictEqual(profileOf(read)?.["name"], "Ada Seeker");
    }),
  );

  it.effect("lets an unassigned legacy account adopt the listing profile it saves", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("save-legacy-lister");

      const saved = yield* saveProfile(user, listerPayload());

      assert.strictEqual(saved.status, 200, saved.body);
      assert.strictEqual(roleOf(saved), "lister");
      assert.strictEqual(profileOf(saved)?.["ownership"], "leaseholder");
      assert.strictEqual(yield* storedRole(user.id), "lister");
      assert.strictEqual(yield* countFor("listers", user.id), 1);
      assert.strictEqual(yield* countFor("seekers", user.id), 0);

      const read = yield* profile(user);
      assert.strictEqual(read.status, 200, read.body);
      assert.strictEqual(roleOf(read), "lister");
      assert.strictEqual(profileOf(read)?.["ownership"], "leaseholder");
    }),
  );

  it.effect("rejects a payload that is missing a required seeking field", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("invalid-seeker");

      const noName = yield* saveProfile(user, seekerPayload({ name: undefined }));
      assert.strictEqual(noName.status, 400, noName.body);

      const blankName = yield* saveProfile(user, seekerPayload({ name: "   " }));
      assert.strictEqual(blankName.status, 400, blankName.body);

      const noBirthDate = yield* saveProfile(user, seekerPayload({ dateOfBirth: undefined }));
      assert.strictEqual(noBirthDate.status, 400, noBirthDate.body);

      const noGender = yield* saveProfile(user, seekerPayload({ gender: undefined }));
      assert.strictEqual(noGender.status, 400, noGender.body);

      const badGender = yield* saveProfile(user, seekerPayload({ gender: "alien" }));
      assert.strictEqual(badGender.status, 400, badGender.body);

      // A rejected save writes nothing, so the blank row is still blank.
      assert.isNull((yield* seekerRow(user.id))?.name);
    }),
  );

  it.effect("rejects a birth date in the future", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("invalid-future");

      const response = yield* saveProfile(
        user,
        seekerPayload({ dateOfBirth: Date.now() + 24 * 60 * 60 * 1000 }),
      );

      assert.strictEqual(response.status, 400, response.body);
      assert.strictEqual(bodyOf(response)["_tag"], "ProfileValidationError");
      assert.isNull((yield* seekerRow(user.id))?.name);
    }),
  );

  it.effect("rejects a listing payload for a seeking account and the other way round", () =>
    Effect.gen(function* () {
      const seeking = yield* freshUser("wrong-shape-seeker");
      const wrongForSeeker = yield* saveProfile(seeking, listerPayload());
      assert.strictEqual(wrongForSeeker.status, 400, wrongForSeeker.body);
      assert.strictEqual(bodyOf(wrongForSeeker)["_tag"], "ProfileValidationError");

      const listing = yield* listingUser("wrong-shape-lister");
      const wrongForLister = yield* saveProfile(listing, seekerPayload());
      assert.strictEqual(wrongForLister.status, 400, wrongForLister.body);
      assert.strictEqual(bodyOf(wrongForLister)["_tag"], "ProfileValidationError");
    }),
  );

  it.effect("rejects an unauthenticated caller with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("PUT", "/api/users/profile", { payload: seekerPayload() });
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("refuses an admin account that holds no profile", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("save-admin");
      yield* deleteProfile("seekers", user.id);
      yield* setRole(user.id, "admin");

      const response = yield* saveProfile(user, seekerPayload());

      assert.strictEqual(response.status, 409, response.body);
      assert.strictEqual(bodyOf(response)["_tag"], "ProfileUnavailableError");
      // The admin holds no profile row, and the refused save opened none.
      assert.strictEqual(yield* countFor("seekers", user.id), 0);
    }),
  );

  // The session is the identity: an id in the payload cannot redirect the write
  // to another account, and nothing about the other account is readable.
  it.effect("scopes the write to the caller, never to an id in the payload", () =>
    Effect.gen(function* () {
      const owner = yield* freshUser("scope-owner");
      const other = yield* freshUser("scope-other");
      yield* saveProfile(owner, seekerPayload({ name: "Owner Name" }));

      const written = yield* saveProfile(
        other,
        seekerPayload({ name: "Other Name", userId: owner.id }),
      );
      assert.strictEqual(written.status, 200, written.body);
      assert.strictEqual(profileOf(written)?.["userId"], other.id);
      assert.strictEqual(profileOf(written)?.["name"], "Other Name");

      assert.strictEqual((yield* seekerRow(owner.id))?.name, "Owner Name");
      assert.strictEqual((yield* seekerRow(other.id))?.name, "Other Name");

      const read = yield* profile(other);
      assert.strictEqual(profileOf(read)?.["userId"], other.id);
      assert.strictEqual(profileOf(read)?.["name"], "Other Name");
    }),
  );
});

/*
 * The role switch is the path to the other profile. Registration opened the
 * seeking row blank, so switching to seeking has to work before the details are
 * filled in, and the details must survive a round trip through listing.
 */
describe("the switch to seeking around the profile details", () => {
  it.effect("switches to a blank seeking profile, then keeps the details once filled in", () =>
    Effect.gen(function* () {
      const user = yield* listingUser("switch-seeker");

      const blank = yield* changeRole(user);
      assert.strictEqual(blank.status, 200, blank.body);
      const blankProfile = asObject(bodyOf(blank)["newProfile"]);
      assert.strictEqual(blankProfile["userId"], user.id);
      assert.isNull(blankProfile["name"]);

      const saved = yield* saveProfile(user, seekerPayload({ name: "Ada Roundtrip" }));
      assert.strictEqual(saved.status, 200, saved.body);

      yield* changeRole(user);
      const back = yield* changeRole(user);
      assert.strictEqual(back.status, 200, back.body);
      const stored = asObject(bodyOf(back)["newProfile"]);
      assert.strictEqual(stored["name"], "Ada Roundtrip");
      assert.strictEqual(stored["userId"], user.id);

      const read = yield* profile(user);
      assert.strictEqual(roleOf(read), "seeker");
      assert.strictEqual(profileOf(read)?.["name"], "Ada Roundtrip");
    }),
  );
});
