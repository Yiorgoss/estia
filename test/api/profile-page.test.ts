import { call, form, query, register } from "../support/api";
import type { TestUser } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The profile page, driven through the private router the way a browser drives
 * it: a GET renders the form for the account's stored role and a form post
 * answers with a redirect on success or the same page carrying the reason on
 * failure. The page is not part of the JSON API, so a signed-out visitor gets
 * the sign-in prompt, never a bare 401 body.
 */

const page = (user: TestUser) =>
  call("/profile", { headers: { cookie: user.cookie, "user-agent": "estia-tests" } });

const submit = (user: TestUser, fields: Readonly<Record<string, string>>) =>
  call(
    "/profile",
    form({ method: "POST", headers: { cookie: user.cookie, "user-agent": "estia-tests" } }, fields),
  );

const switchRole = (user: TestUser) =>
  call(
    "/profile/switch",
    form({ method: "POST", headers: { cookie: user.cookie, "user-agent": "estia-tests" } }, {}),
  );

const switchTo = (user: TestUser, role: "seeker" | "lister") =>
  call(
    "/profile/switch",
    form(
      { method: "POST", headers: { cookie: user.cookie, "user-agent": "estia-tests" } },
      {
        role,
      },
    ),
  );

const setRole = (id: string, role: string) =>
  query("UPDATE users SET role = ? WHERE id = ?", [role, id]);

const storedRole = (id: string) =>
  Effect.map(
    query<{ role: string }>("SELECT role FROM users WHERE id = ?", [id]),
    (rows) => rows[0]?.role,
  );

const deleteProfile = (table: "seekers" | "listers", id: string) =>
  query(`DELETE FROM ${table} WHERE user_id = ?`, [id]);

const seekerForm = (overrides: Record<string, string> = {}): Record<string, string> => ({
  name: "Ada Seeker",
  dateOfBirth: "1995-04-12",
  gender: "female",
  bio: "Looking for a quiet room",
  smoking: "true",
  ...overrides,
});

const freshUser = (label: string) => register(`profile-page-${label}`);

const legacyUser = (label: string) =>
  Effect.gen(function* () {
    const user = yield* freshUser(label);
    yield* deleteProfile("seekers", user.id);
    yield* deleteProfile("listers", user.id);
    yield* setRole(user.id, "user");
    return user;
  });

describe("GET /profile", () => {
  it.effect("renders the incomplete seeking form for a fresh account", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("fresh");

      const response = yield* page(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, 'action="/profile"');
      assert.include(response.body, "Your seeking profile is incomplete");
      assert.include(response.body, "Add your name, date of birth and gender");
      assert.include(response.body, 'name="name"');
      assert.include(response.body, 'name="dateOfBirth"');
      assert.include(response.body, 'name="gender"');
      assert.include(response.body, 'name="bio"');
      assert.include(response.body, "Save profile");
      // The header reaches the page from everywhere else in the site.
      assert.include(response.body, 'href="/profile"');
    }),
  );

  it.effect("offers a way to log out that posts the logout route", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("logout-control");

      const response = yield* page(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, 'action="/api/auth/logout"');
      assert.include(response.body, ">Log out</button>");
    }),
  );

  it.effect("asks an unauthenticated visitor to sign in instead of answering a 401 body", () =>
    Effect.gen(function* () {
      const response = yield* call("/profile");

      assert.strictEqual(response.status, 401);
      assert.include(response.body, "Sign in required");
      assert.notInclude(response.body, "UnauthorizedError");
    }),
  );

  // An account whose row was never opened still gets a usable, empty form, so the
  // first save can repair it.
  it.effect("renders an empty form for an account whose profile row is missing", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("no-row");
      yield* deleteProfile("seekers", user.id);

      const response = yield* page(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, "Your seeking profile is incomplete");
      assert.include(response.body, 'value=""');
    }),
  );

  // A legacy account with no role has no profile form to show yet, so the page
  // offers the two profiles and lets the person pick a side of the market.
  it.effect("offers an unassigned account the choice of profile", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("unassigned");

      const response = yield* page(user);

      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, "Choose a profile");
      assert.include(response.body, 'action="/profile/switch"');
      assert.include(response.body, 'value="seeker"');
      assert.include(response.body, 'value="lister"');
      assert.notInclude(response.body, 'action="/profile"');
      // The choice page is still the profile page, so it still has the way out.
      assert.include(response.body, 'action="/api/auth/logout"');
    }),
  );

  it.effect("refuses an admin account that holds no profile", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("admin");
      yield* deleteProfile("seekers", user.id);
      yield* setRole(user.id, "admin");

      const response = yield* page(user);

      assert.strictEqual(response.status, 409, response.body);
      assert.include(response.body, "An admin account has no profile");
      assert.notInclude(response.body, 'action="/profile"');
    }),
  );
});

describe("POST /profile", () => {
  it.effect("saves the seeking form, redirects, and shows the stored values", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("save");
      const saved = yield* submit(user, seekerForm());

      assert.strictEqual(saved.status, 303, saved.body);
      assert.strictEqual(saved.location, "/profile?saved=1");

      const read = yield* call("/profile?saved=1", {
        headers: { cookie: user.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(read.status, 200, read.body);
      assert.include(read.body, "Your profile was saved.");
      assert.include(read.body, 'value="Ada Seeker"');
      assert.include(read.body, 'value="1995-04-12"');
      assert.include(read.body, "Looking for a quiet room");
      // The required fields are in place, so the notice is gone.
      assert.notInclude(read.body, "Your seeking profile is incomplete");
    }),
  );

  it.effect("reports a missing required field and keeps what was typed", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("missing-name");

      const response = yield* submit(user, seekerForm({ name: "  ", bio: "Still here" }));

      assert.strictEqual(response.status, 400, response.body);
      assert.include(response.body, "Enter your name.");
      assert.include(response.body, "Still here");
      assert.include(response.body, "Your seeking profile is incomplete");
    }),
  );

  it.effect("reports a value the form cannot read in words a person can act on", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("bad-values");

      const badGender = yield* submit(user, seekerForm({ gender: "alien" }));
      assert.strictEqual(badGender.status, 400, badGender.body);
      assert.include(badGender.body, "Choose your gender.");

      const badDate = yield* submit(user, seekerForm({ dateOfBirth: "1995-02-31" }));
      assert.strictEqual(badDate.status, 400, badDate.body);
      assert.include(badDate.body, "That is not a real date.");

      const missingDate = yield* submit(user, seekerForm({ dateOfBirth: "" }));
      assert.strictEqual(missingDate.status, 400, missingDate.body);
      assert.include(missingDate.body, "Enter your date of birth.");
    }),
  );

  it.effect("explains a refused save from another site and writes nothing", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("cross-site");

      const response = yield* call(
        "/profile",
        form(
          {
            method: "POST",
            headers: { cookie: user.cookie, origin: "https://evil.example" },
          },
          seekerForm(),
        ),
      );

      assert.strictEqual(response.status, 403, response.body);
      assert.include(response.body, "can only be submitted from this site");

      const row = yield* query<{ name: string | null }>(
        "SELECT name FROM seekers WHERE user_id = ?",
        [user.id],
      );
      assert.isNull(row[0]?.name);
    }),
  );

  it.effect("shows the saved state on the listing profile after switching roles", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("lister");

      const switched = yield* switchRole(user);
      assert.strictEqual(switched.status, 303, switched.body);
      assert.strictEqual(switched.location, "/profile");

      const listingForm = yield* page(user);
      assert.strictEqual(listingForm.status, 200, listingForm.body);
      assert.include(listingForm.body, "Listing profile");
      assert.include(listingForm.body, 'name="ownership"');
      assert.include(listingForm.body, "Switch to my seeking profile");

      const saved = yield* submit(user, { name: "Ada Lets", ownership: "leaseholder" });
      assert.strictEqual(saved.status, 303, saved.body);
      assert.strictEqual(saved.location, "/profile?saved=1");

      const read = yield* call("/profile?saved=1", {
        headers: { cookie: user.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(read.status, 200, read.body);
      assert.include(read.body, "Your profile was saved.");
      assert.include(read.body, 'value="Ada Lets"');
      assert.include(read.body, '<option value="leaseholder" selected>');
    }),
  );

  it.effect("reports a listing form without an ownership", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("lister-no-ownership");
      yield* switchRole(user);

      const response = yield* submit(user, { name: "Ada Lets", ownership: "" });

      assert.strictEqual(response.status, 400, response.body);
      assert.include(response.body, "Choose whether you own the place or hold its lease.");
    }),
  );
});

describe("POST /profile/switch", () => {
  it.effect("adopts the seeking profile an unassigned account chooses", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("adopt-seeker");

      const switched = yield* switchTo(user, "seeker");

      assert.strictEqual(switched.status, 303, switched.body);
      assert.strictEqual(switched.location, "/profile");
      assert.strictEqual(yield* storedRole(user.id), "seeker");

      const form = yield* page(user);
      assert.strictEqual(form.status, 200, form.body);
      assert.include(form.body, "Seeking profile");
      assert.include(form.body, 'name="dateOfBirth"');
    }),
  );

  it.effect("adopts the listing profile an unassigned account chooses", () =>
    Effect.gen(function* () {
      const user = yield* legacyUser("adopt-lister");

      const switched = yield* switchTo(user, "lister");

      assert.strictEqual(switched.status, 303, switched.body);
      assert.strictEqual(switched.location, "/profile");
      assert.strictEqual(yield* storedRole(user.id), "lister");

      const form = yield* page(user);
      assert.strictEqual(form.status, 200, form.body);
      assert.include(form.body, "Listing profile");
      assert.include(form.body, 'name="ownership"');
    }),
  );

  // A stored lister whose lister row is missing heals that row on the first
  // switch instead of changing the role. Saying so keeps the click honest, and
  // the second click performs the switch.
  it.effect("says the profile was completed when the first switch only heals it", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("heal-lister");
      yield* deleteProfile("listers", user.id);
      yield* setRole(user.id, "lister");

      const healed = yield* switchRole(user);

      assert.strictEqual(healed.status, 303, healed.body);
      assert.strictEqual(healed.location, "/profile?completed=1");
      assert.strictEqual(yield* storedRole(user.id), "lister");
      assert.strictEqual(
        (yield* query<{ total: number }>(
          "SELECT COUNT(*) AS total FROM listers WHERE user_id = ?",
          [user.id],
        ))[0]?.total,
        1,
      );

      const after = yield* call("/profile?completed=1", {
        headers: { cookie: user.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(after.status, 200, after.body);
      assert.include(after.body, "This profile was completed.");
      assert.include(after.body, "Switch to my seeking profile");

      const switched = yield* switchRole(user);
      assert.strictEqual(switched.status, 303, switched.body);
      assert.strictEqual(switched.location, "/profile");
      assert.strictEqual(yield* storedRole(user.id), "seeker");
    }),
  );

  it.effect("switches the account to its other profile and back", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("switch");

      yield* switchRole(user);
      const listing = yield* query<{ role: string }>("SELECT role FROM users WHERE id = ?", [
        user.id,
      ]);
      assert.strictEqual(listing[0]?.role, "lister");

      yield* switchRole(user);
      const seeking = yield* query<{ role: string }>("SELECT role FROM users WHERE id = ?", [
        user.id,
      ]);
      assert.strictEqual(seeking[0]?.role, "seeker");
    }),
  );

  it.effect("refuses a switch from another site", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("switch-cross-site");

      const response = yield* call(
        "/profile/switch",
        form(
          { method: "POST", headers: { cookie: user.cookie, origin: "https://evil.example" } },
          {},
        ),
      );

      assert.strictEqual(response.status, 403, response.body);
      const stored = yield* query<{ role: string }>("SELECT role FROM users WHERE id = ?", [
        user.id,
      ]);
      assert.strictEqual(stored[0]?.role, "seeker");
    }),
  );

  it.effect("answers a signed-out post with the sign-in prompt", () =>
    Effect.gen(function* () {
      const response = yield* call("/profile/switch", form({ method: "POST" }, {}));
      assert.strictEqual(response.status, 401);
      assert.include(response.body, "Sign in required");
    }),
  );
});

// The profile is user input, so nothing typed into it may reach the page as
// markup.
describe("profile rendering", () => {
  it.effect("escapes the stored values it echoes back", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("escaping");
      const name = '<script>alert("x")</script>';

      const saved = yield* submit(user, seekerForm({ name, bio: "<b>bold</b>" }));
      assert.strictEqual(saved.status, 303, saved.body);

      const read = yield* page(user);
      assert.notInclude(read.body, name);
      assert.notInclude(read.body, "<b>bold</b>");
      assert.include(read.body, "&lt;script&gt;");
      assert.include(read.body, "&lt;b&gt;bold&lt;/b&gt;");
    }),
  );

  // A payload is only ever applied to the role the account holds, so the page
  // never shows a listing form to a seeking account.
  it.effect("keeps the form on the account's stored role", () =>
    Effect.gen(function* () {
      const user = yield* freshUser("role-locked");

      const response = yield* submit(user, { ownership: "owner" });

      assert.strictEqual(response.status, 400, response.body);
      assert.include(response.body, "Your seeking profile is incomplete");
    }),
  );
});
