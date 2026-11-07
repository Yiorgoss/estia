import { asObject, call, form, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The sign-in and registration forms post `application/x-www-form-urlencoded`,
 * which is what a browser sends for a plain form and what htmx sent before these
 * routes existed. The JSON `/api/auth` endpoints only ever accepted JSON, so a
 * form submission answered 415 and the page showed nothing at all.
 *
 * These tests drive the encoding a browser really sends through the real public
 * router. They also pin the parts of the defect that travelled with the 415: a
 * successful submit must set the session cookies and move the person on, a
 * failure must come back as a readable message with an honest status, and the
 * repeat-password box must be checked.
 */

const PASSWORD = "correct horse battery staple";

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

const submit = (path: string, fields: Readonly<Record<string, string>>) =>
  call(path, form({ method: "POST" }, fields));

const APP_ORIGIN = "http://listings.test";

const submitFrom = (
  path: string,
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
) => call(path, form({ method: "POST", headers }, fields));

const credentials = (email: string, password = PASSWORD) => ({ email, password });

const jobForm = (email: string, password = PASSWORD, repeated = password) => ({
  email,
  password,
  repeat_password: repeated,
});

describe("POST /register", () => {
  it.effect("accepts the encoding a browser form sends and signs the person in", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("form-register");
      const response = yield* submit("/register", jobForm(email));

      assert.strictEqual(response.status, 303, response.body);
      assert.strictEqual(response.location, "/search");
      assert.isString(response.cookies["access_token"]);
      assert.isString(response.cookies["refresh_token"]);

      // The account really exists and the chosen password works, which is what
      // the redirect promises.
      const login = yield* submit("/login", credentials(email));
      assert.strictEqual(login.status, 303, login.body);
      assert.isString(login.cookies["access_token"]);
    }),
  );

  it.effect("rejects a mismatched repeat password before creating an account", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("form-mismatch");
      const rejected = yield* submit("/register", jobForm(email, PASSWORD, `${PASSWORD}!`));

      assert.strictEqual(rejected.status, 400);
      assert.include(rejected.body, "The two passwords do not match");

      // Nothing was created, so the same address can still register.
      const accepted = yield* submit("/register", jobForm(email));
      assert.strictEqual(accepted.status, 303, accepted.body);
    }),
  );

  it.effect("explains a duplicate email with a 409 a person can act on", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("form-duplicate");
      const first = yield* submit("/register", jobForm(email));
      assert.strictEqual(first.status, 303, first.body);

      const second = yield* submit("/register", jobForm(email));
      assert.strictEqual(second.status, 409);
      assert.include(second.body, "already exists");
      assert.include(second.body, "Sign in instead");
      assert.isUndefined(second.cookies["access_token"]);
    }),
  );

  it.effect("reports the missing field instead of answering something unreadable", () =>
    Effect.gen(function* () {
      const response = yield* submit("/register", {
        email: "",
        password: PASSWORD,
        repeat_password: PASSWORD,
      });

      assert.strictEqual(response.status, 400);
      assert.include(response.body, "Enter the email address you want to use.");
    }),
  );

  it.effect("rejects a JSON body on the form route, which is not the surface for it", () =>
    Effect.gen(function* () {
      const response = yield* call(
        "/register",
        form({ method: "POST", headers: { "content-type": "application/json" } }, {}),
      );
      assert.strictEqual(response.status, 415);
      assert.include(response.body, "expects a form submission");
    }),
  );
});

describe("POST /login", () => {
  it.effect("accepts the encoding a browser form sends and signs the person in", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("form-login");
      yield* submit("/register", jobForm(email));

      const response = yield* submit("/login", credentials(email));
      assert.strictEqual(response.status, 303, response.body);
      assert.strictEqual(response.location, "/search");
      assert.isString(response.cookies["access_token"]);
      assert.isString(response.cookies["refresh_token"]);
    }),
  );

  it.effect("shows a readable message for a wrong password", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("form-wrong-password");
      yield* submit("/register", jobForm(email));

      const response = yield* submit("/login", credentials(email, "not the password"));
      assert.strictEqual(response.status, 401);
      assert.include(response.body, "That email and password do not match");
      assert.isUndefined(response.cookies["access_token"]);
    }),
  );

  it.effect("shows the same message for an unknown email", () =>
    Effect.gen(function* () {
      const response = yield* submit("/login", credentials(uniqueEmail("form-unknown")));
      assert.strictEqual(response.status, 401);
      assert.include(response.body, "That email and password do not match");
    }),
  );

  it.effect("reports a missing password instead of an empty form", () =>
    Effect.gen(function* () {
      const response = yield* submit("/login", {
        email: uniqueEmail("form-missing"),
        password: "",
      });
      assert.strictEqual(response.status, 400);
      assert.include(response.body, "Enter your password.");
    }),
  );
});

/*
 * A form post is a simple request, so the browser sends it cross-site without
 * asking the server first. These tests drive a submit that the browser labels as
 * coming from another site, and check it is refused before it can plant a
 * session for the wrong account.
 */
describe("form posts from another site", () => {
  it.effect("accepts a submit the browser marks as same-origin or user-initiated", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("same-origin");
      const registered = yield* submitFrom("/register", jobForm(email), {
        origin: APP_ORIGIN,
        "sec-fetch-site": "same-origin",
      });
      assert.strictEqual(registered.status, 303, registered.body);
      assert.isString(registered.cookies["access_token"]);

      const signedIn = yield* submitFrom("/login", credentials(email), {
        "sec-fetch-site": "none",
      });
      assert.strictEqual(signedIn.status, 303, signedIn.body);
      assert.isString(signedIn.cookies["access_token"]);
    }),
  );

  it.effect("accepts a submit that carries none of the browser origin headers", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("headerless");
      const response = yield* submit("/register", jobForm(email));
      assert.strictEqual(response.status, 303, response.body);
      assert.isString(response.cookies["access_token"]);
    }),
  );

  it.effect("rejects a cross-origin register without a session or an account", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("cross-origin-register");
      const rejected = yield* submitFrom("/register", jobForm(email), {
        origin: "https://evil.example",
      });
      assert.strictEqual(rejected.status, 403, rejected.body);
      assert.isUndefined(rejected.cookies["access_token"]);
      assert.isUndefined(rejected.cookies["refresh_token"]);

      // The refused submit created nothing, so the address is still free.
      const accepted = yield* submit("/register", jobForm(email));
      assert.strictEqual(accepted.status, 303, accepted.body);
    }),
  );

  it.effect("rejects a cross-origin sign-in without a session", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("cross-origin-login");
      yield* submit("/register", jobForm(email));

      const rejected = yield* submitFrom("/login", credentials(email), {
        origin: "https://evil.example",
      });
      assert.strictEqual(rejected.status, 403, rejected.body);
      assert.isUndefined(rejected.cookies["access_token"]);
      assert.isUndefined(rejected.cookies["refresh_token"]);
    }),
  );

  it.effect("rejects a submit the browser marks as cross-site", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("cross-site-fetch");
      const rejected = yield* submitFrom("/register", jobForm(email), {
        "sec-fetch-site": "cross-site",
      });
      assert.strictEqual(rejected.status, 403, rejected.body);
      assert.isUndefined(rejected.cookies["access_token"]);
    }),
  );

  it.effect("falls back to the Referer when there is no Origin", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("referer");
      const fromElsewhere = yield* submitFrom("/register", jobForm(email), {
        referer: "https://evil.example/register",
      });
      assert.strictEqual(fromElsewhere.status, 403, fromElsewhere.body);
      assert.isUndefined(fromElsewhere.cookies["access_token"]);

      const fromApp = yield* submitFrom("/register", jobForm(email), {
        referer: `${APP_ORIGIN}/register`,
      });
      assert.strictEqual(fromApp.status, 303, fromApp.body);
      assert.isString(fromApp.cookies["access_token"]);
    }),
  );
});

/*
 * The JSON API keeps its own contract: a JSON client still registers exactly as
 * before, and a duplicate is a 409 instead of the 500 it used to collapse into.
 */
describe("the JSON auth endpoints", () => {
  it.effect("still register a JSON client and answer a duplicate with 409", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("json-duplicate");
      const first = yield* send("POST", "/api/auth/register", { payload: credentials(email) });
      assert.strictEqual(first.status, 200, first.body);

      const second = yield* send("POST", "/api/auth/register", { payload: credentials(email) });
      assert.strictEqual(second.status, 409, second.body);
      assert.strictEqual(asObject(second.json)["_tag"], "UserAlreadyExistsError");
    }),
  );

  it.effect("still sign a JSON client in with JSON", () =>
    Effect.gen(function* () {
      const email = uniqueEmail("json-login");
      yield* send("POST", "/api/auth/register", { payload: credentials(email) });

      const response = yield* send("POST", "/api/auth/login", { payload: credentials(email) });
      assert.strictEqual(response.status, 200, response.body);
      assert.isString(response.cookies["access_token"]);
      assert.isString(response.cookies["refresh_token"]);
    }),
  );
});
