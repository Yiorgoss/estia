import { SavedSearchRowSchema } from "@/db/schema/SavedSearch";
import { savedSearchResultsHref } from "@/frontend/saved-search";
import { call, form, query, register, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

/*
 * The saved-search feature through the real public and private routers: the
 * browser's save and delete forms, the search page that lists what was saved,
 * and the listing search the stored criteria re-run.
 */

const users = await Effect.runPromise(
  Effect.gen(function* () {
    const owner = yield* register("saved-owner");
    return { owner };
  }),
);

const PASSWORD = "correct horse battery staple";

interface BrowserSession {
  readonly id: string;
  readonly access: string;
  readonly refresh: string;
}

const signIn = (label: string): Effect.Effect<BrowserSession> =>
  Effect.gen(function* () {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const response = yield* send("POST", "/api/auth/register", {
      payload: { email, password: PASSWORD },
    });
    assert.strictEqual(response.status, 200, response.body);
    const access = response.cookies["access_token"];
    const refresh = response.cookies["refresh_token"];
    const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
    return { id: String(claims.id), access, refresh };
  });

// The rows the session's account has stored, newest first, read from the table
// the routes wrote them to.
const storedSearches = (userId: string) =>
  query("SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC, id DESC", [
    userId,
  ]).pipe(
    Effect.map((rows) =>
      rows.map((row) => Schema.decodeUnknownSync(SavedSearchRowSchema)(row)),
    ),
  );

const browserSave = (
  cookie: string,
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
) =>
  call(
    "/search/saved",
    form(
      { method: "POST", headers: { cookie, "hx-request": "true", ...headers } },
      fields,
    ),
  );

const staleAccess = (session: BrowserSession) =>
  `access_token=an.expired.token; refresh_token=${session.refresh}`;

const browser = (cookie: string) => ({ "user-agent": "estia-tests", cookie });

/*
 * What a browser would post when the search form is submitted: every named
 * input keeps its value, an unchecked box is left out, and a select posts the
 * selected option (the first one when none is marked).
 */
const searchFormFields = (html: string): Record<string, string> => {
  const start = html.indexOf('id="search-form"');
  const formHtml = html.slice(start, html.indexOf("</form>", start));
  const fields: Record<string, string> = {};

  for (const input of formHtml.matchAll(/<input\b[^>]*>/g)) {
    const tag = input[0];
    const name = /\bname="([^"]+)"/.exec(tag)?.[1];
    if (name === undefined) continue;
    if (/\btype="(?:checkbox|radio)"/.test(tag) && !/\bchecked\b/.test(tag)) continue;
    fields[name] = /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? "";
  }

  for (const select of formHtml.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = /\bname="([^"]+)"/.exec(select[1] ?? "")?.[1];
    if (name === undefined) continue;
    const selected = /<option value="([^"]*)" selected>/.exec(select[2] ?? "");
    const first = /<option value="([^"]*)"/.exec(select[2] ?? "");
    fields[name] = selected?.[1] ?? first?.[1] ?? "";
  }

  return fields;
};

const resultsUrlOf = (html: string): string => {
  const encoded = /id="results"\s+hx-get="([^"]+)"/.exec(html)?.[1];
  if (encoded === undefined) throw new Error("the results section has no url");
  return encoded.replace(/&amp;/g, "&");
};

const criteriaOf = (saved: typeof SavedSearchRowSchema.Type) => ({
  kind: saved.kind,
  regionCode: saved.regionCode,
  minPriceMinor: saved.minPriceMinor,
  maxPriceMinor: saved.maxPriceMinor,
  minSizeSqm: saved.minSizeSqm,
  maxSizeSqm: saved.maxSizeSqm,
  furnished: saved.furnished,
  ensuite: saved.ensuite,
  smoking: saved.smoking,
  pets: saved.pets,
  availableFrom: saved.availableFrom,
});

describe("the browser's saved-search routes", () => {
  it.effect("saves an htmx post whose access token aged out", () =>
    Effect.gen(function* () {
      const session = yield* signIn("htmx-expired-save");

      const response = yield* browserSave(staleAccess(session), { pets: "false" });
      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, 'id="saved-searches"');
      assert.include(response.body, "Saved:");

      const access = response.cookies["access_token"];
      const refresh = response.cookies["refresh_token"];
      assert.isDefined(access);
      assert.isDefined(refresh);
      assert.notStrictEqual(access, "an.expired.token");
      assert.notStrictEqual(refresh, session.refresh);

      const listed = yield* storedSearches(session.id);
      assert.lengthOf(listed, 1);
      assert.strictEqual(listed[0]?.pets, false);

      // The rotated pair, not the consumed refresh token, is the credential the
      // next click carries.
      const next = yield* browserSave(
        `access_token=${access}; refresh_token=${refresh}`,
        { pets: "false" },
      );
      assert.strictEqual(next.status, 200, next.body);
      assert.include(next.body, "Saved:");
    }),
  );

  it.effect("saves for a navigation without htmx and rotates the session", () =>
    Effect.gen(function* () {
      const session = yield* signIn("forms-expired-save");

      const response = yield* call(
        "/search/saved",
        form({ method: "POST", headers: { cookie: staleAccess(session) } }, { pets: "false" }),
      );
      assert.strictEqual(response.status, 303, response.body);
      assert.strictEqual(response.location, "/search");
      assert.notStrictEqual(response.cookies["refresh_token"], session.refresh);

      const listed = yield* storedSearches(session.id);
      assert.lengthOf(listed, 1);
    }),
  );

  it.effect("deletes an htmx post whose access token aged out", () =>
    Effect.gen(function* () {
      const session = yield* signIn("htmx-expired-delete");
      const created = yield* browserSave(`access_token=${session.access}`, {
        name: "Removed after a stale click",
      });
      assert.strictEqual(created.status, 200, created.body);
      const [stored] = yield* storedSearches(session.id);
      assert.isDefined(stored);

      const response = yield* call(
        `/search/saved/${String(stored.id)}/delete`,
        form(
          {
            method: "POST",
            headers: { cookie: staleAccess(session), "hx-request": "true" },
          },
          {},
        ),
      );
      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, "Saved search deleted.");
      assert.notStrictEqual(response.cookies["refresh_token"], session.refresh);

      const listed = yield* storedSearches(session.id);
      assert.notInclude(
        listed.map((saved) => saved.id),
        stored.id,
      );
    }),
  );

  it.effect("keeps the save control outside the results a search refresh swaps", () =>
    Effect.gen(function* () {
      const session = yield* signIn("save-name-survives");
      const cookie = `access_token=${session.access}`;

      const page = yield* call("/search", { headers: browser(cookie) });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, 'id="saved-search-name"');
      assert.include(page.body, 'hx-include="#search-form"');

      // The debounced re-run swaps only #results, so it cannot re-create the name
      // box and the name typed there survives.
      const refreshed = yield* call("/search/results?pets=false", {
        headers: { ...browser(cookie), "hx-request": "true" },
      });
      assert.strictEqual(refreshed.status, 200, refreshed.body);
      assert.notInclude(refreshed.body, 'id="saved-search-name"');
      assert.notInclude(refreshed.body, 'hx-post="/search/saved"');

      const saved = yield* browserSave(cookie, { name: "Cheap Attica", pets: "false" });
      assert.strictEqual(saved.status, 200, saved.body);
      assert.include(saved.body, "Saved: Cheap Attica");

      const [stored] = yield* storedSearches(session.id);
      assert.isDefined(stored);
      assert.strictEqual(stored.name, "Cheap Attica");
    }),
  );

  it.effect("answers a failed save or delete without htmx as a navigation", () =>
    Effect.gen(function* () {
      const session = yield* signIn("non-htmx-failures");
      const cookie = `access_token=${session.access}`;

      const badFilter = yield* call(
        "/search/saved",
        form({ method: "POST", headers: { cookie } }, { minPrice: "not-a-number" }),
      );
      assert.strictEqual(badFilter.status, 303, badFilter.body);
      assert.strictEqual(badFilter.location, "/search");

      const missing = yield* call(
        "/search/saved/not-an-id/delete",
        form({ method: "POST", headers: { cookie } }, {}),
      );
      assert.strictEqual(missing.status, 303, missing.body);
      assert.strictEqual(missing.location, "/search");
    }),
  );

  it.effect("renders a cross-site refusal in the panel for htmx", () =>
    Effect.gen(function* () {
      const created = yield* browserSave(users.owner.cookie, { name: "Cross-site target" });
      assert.strictEqual(created.status, 200, created.body);
      const [stored] = yield* storedSearches(users.owner.id);
      assert.isDefined(stored);

      const save = yield* browserSave(
        users.owner.cookie,
        { pets: "false" },
        { origin: "https://evil.example" },
      );
      assert.strictEqual(save.status, 200, save.body);
      assert.include(save.body, 'id="saved-searches"');
      assert.include(save.body, "can only be submitted from this site");
      assert.include(save.body, "Cross-site target");

      const removeResponse = yield* call(
        `/search/saved/${String(stored.id)}/delete`,
        form(
          {
            method: "POST",
            headers: {
              cookie: users.owner.cookie,
              origin: "https://evil.example",
              "hx-request": "true",
            },
          },
          {},
        ),
      );
      assert.strictEqual(removeResponse.status, 200, removeResponse.body);
      assert.include(removeResponse.body, 'id="saved-searches"');
      assert.include(removeResponse.body, "can only be submitted from this site");
      assert.include(removeResponse.body, "Cross-site target");

      const after = yield* storedSearches(users.owner.id);
      assert.include(
        after.map((saved) => saved.id),
        stored.id,
      );
    }),
  );

  it.effect("keeps the 403 for a cross-site form post without htmx", () =>
    Effect.gen(function* () {
      const response = yield* call(
        "/search/saved",
        form(
          { method: "POST", headers: { cookie: users.owner.cookie, origin: "https://evil.example" } },
          { pets: "false" },
        ),
      );
      assert.strictEqual(response.status, 403, response.body);
      assert.include(response.body, "can only be submitted from this site");
    }),
  );
});

describe("reopening a saved search from the list", () => {
  it.effect("keeps a negative flag and re-runs the exact stored criteria", () =>
    Effect.gen(function* () {
      const saved = yield* browserSave(users.owner.cookie, {
        kind: "room",
        regionCode: "attica",
        minPrice: "400",
        maxPrice: "800",
        minSizeSqm: "20",
        furnished: "true",
        pets: "false",
        availableFrom: "2026-03-01",
      });
      assert.strictEqual(saved.status, 200, saved.body);
      assert.include(saved.body, "Saved:");

      const [stored] = yield* storedSearches(users.owner.id);
      assert.isDefined(stored);
      assert.include(stored.name, "No pets");

      const page = yield* call(`/search?saved=${String(stored.id)}`, {
        headers: { cookie: users.owner.cookie },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, "No pets");
      assert.include(page.body, 'aria-current="page"');

      const reopened = searchFormFields(page.body);
      assert.strictEqual(reopened["pets"], "false");
      assert.strictEqual(reopened["furnished"], "true");

      const rerun = resultsUrlOf(page.body);
      assert.strictEqual(new URLSearchParams(rerun.split("?")[1] ?? "").get("pets"), "false");
      assert.strictEqual(rerun, savedSearchResultsHref(stored));

      const resaved = yield* browserSave(users.owner.cookie, reopened);
      assert.strictEqual(resaved.status, 200, resaved.body);

      const [again] = yield* storedSearches(users.owner.id);
      assert.isDefined(again);
      assert.notStrictEqual(again.id, stored.id);
      assert.deepStrictEqual(criteriaOf(again), criteriaOf(stored));
    }),
  );
});

describe("an htmx save with no session", () => {
  it.effect("is sent to the sign-in page instead of silently doing nothing", () =>
    Effect.gen(function* () {
      const response = yield* call(
        "/search/saved",
        form(
          { method: "POST", headers: { "user-agent": "estia-tests", "hx-request": "true" } },
          { pets: "false" },
        ),
      );
      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(response.headers.get("HX-Redirect"), "/login");
      assert.strictEqual(response.body, "");
    }),
  );

  it.effect("keeps the sign-in page for a save that navigates", () =>
    Effect.gen(function* () {
      const response = yield* call(
        "/search/saved",
        form({ method: "POST", headers: { "user-agent": "estia-tests" } }, { pets: "false" }),
      );
      assert.strictEqual(response.status, 401, response.body);
      assert.include(response.body, "Sign in required");
    }),
  );
});

describe("a stale access token on the public search routes", () => {
  it.effect("still identifies the caller, rotates the session, and keeps the saved-search UI", () =>
    Effect.gen(function* () {
      const session = yield* signIn("search-page-rotation");
      const created = yield* browserSave(`access_token=${session.access}`, {
        name: "Returned later",
        pets: "false",
      });
      assert.strictEqual(created.status, 200, created.body);

      const page = yield* call("/search", { headers: browser(staleAccess(session)) });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, 'id="saved-searches"');
      assert.include(page.body, "Returned later");

      const access = page.cookies["access_token"];
      const refresh = page.cookies["refresh_token"];
      assert.isDefined(access);
      assert.isDefined(refresh);
      assert.notStrictEqual(access, "an.expired.token");
      assert.notStrictEqual(refresh, session.refresh);

      const stored = yield* storedSearches(session.id);
      assert.include(
        stored.map((saved) => saved.name),
        "Returned later",
      );

      const results = yield* call("/search/results", {
        headers: browser(`access_token=an.expired.token; refresh_token=${refresh}`),
      });
      assert.strictEqual(results.status, 200, results.body);
      assert.notStrictEqual(results.cookies["refresh_token"], refresh);
    }),
  );

  it.effect("leaves a genuinely signed-out visitor on the public page", () =>
    Effect.gen(function* () {
      const page = yield* call("/search");
      assert.strictEqual(page.status, 200, page.body);
      assert.notInclude(page.body, 'id="saved-searches"');
      assert.isUndefined(page.cookies["access_token"]);

      const results = yield* call("/search/results");
      assert.strictEqual(results.status, 200, results.body);
      assert.notInclude(results.body, 'hx-post="/search/saved"');
    }),
  );

  it.effect("does not retry a pair it has never seen", () =>
    Effect.gen(function* () {
      const page = yield* call("/search", {
        headers: browser("access_token=an.expired.token; refresh_token=never-issued"),
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.notInclude(page.body, 'id="saved-searches"');
      assert.isUndefined(page.cookies["refresh_token"]);
    }),
  );
});

describe("a stale access token on a private page", () => {
  it.effect("names the caller and rotates the pair", () =>
    Effect.gen(function* () {
      const session = yield* signIn("private-page-rotation");

      const page = yield* call("/listings/mine", { headers: browser(staleAccess(session)) });
      assert.strictEqual(page.status, 200, page.body);
      assert.notInclude(page.body, "Sign in required");

      const access = page.cookies["access_token"];
      const refresh = page.cookies["refresh_token"];
      assert.isDefined(access);
      assert.isDefined(refresh);
      assert.notStrictEqual(access, "an.expired.token");
      assert.notStrictEqual(refresh, session.refresh);
    }),
  );
});

describe("two overlapping requests that share one refresh token", () => {
  it.effect("rotates once and lands the winner signed in", () =>
    Effect.gen(function* () {
      const session = yield* signIn("rotation-race-pages");
      const saved = yield* browserSave(`access_token=${session.access}`, { pets: "false" });
      assert.strictEqual(saved.status, 200, saved.body);

      const cookie = staleAccess(session);
      const responses = yield* Effect.all(
        [
          call("/search", { headers: browser(cookie) }),
          call("/search", { headers: browser(cookie) }),
        ],
        { concurrency: 2 },
      );

      const winners = responses.filter((response) => response.cookies["refresh_token"] !== undefined);
      assert.lengthOf(winners, 1);
      const [winner] = winners;
      assert.isDefined(winner);
      assert.include(winner.body, 'id="saved-searches"');

      const access = winner.cookies["access_token"];
      const refresh = winner.cookies["refresh_token"];
      assert.isDefined(access);
      assert.isDefined(refresh);
      assert.notStrictEqual(refresh, session.refresh);

      // The other request either lost the rotation itself and is told to retry,
      // or found the token already spent and reads as a visitor - never as the
      // signed-in page the winner saw.
      const other = responses.find((response) => response !== winner);
      assert.isDefined(other);
      if (other.status === 303) {
        assert.strictEqual(other.location, "/search");
      } else {
        assert.strictEqual(other.status, 200);
        assert.notInclude(other.body, 'id="saved-searches"');
      }

      const page = yield* call("/search", {
        headers: browser(`access_token=${access}; refresh_token=${refresh}`),
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, 'id="saved-searches"');
      assert.include(page.body, "Listings No pets");
    }),
  );

  it.effect("lets exactly one htmx request rotate and reload the other", () =>
    Effect.gen(function* () {
      const session = yield* signIn("rotation-race-htmx");
      const saved = yield* browserSave(`access_token=${session.access}`, { pets: "false" });
      assert.strictEqual(saved.status, 200, saved.body);

      const fragment = "/search/results?pets=false";
      const responses = yield* Effect.all(
        [
          call(fragment, {
            headers: { ...browser(staleAccess(session)), "hx-request": "true" },
          }),
          call(fragment, {
            headers: { ...browser(staleAccess(session)), "hx-request": "true" },
          }),
        ],
        { concurrency: 2 },
      );

      const winners = responses.filter((response) => response.cookies["refresh_token"] !== undefined);
      assert.lengthOf(winners, 1);
      const [winner] = winners;
      assert.isDefined(winner);

      const other = responses.find((response) => response !== winner);
      assert.isDefined(other);
      if (other.headers.get("HX-Refresh") === "true") {
        assert.strictEqual(other.body, "");
      }

      const page = yield* call("/search", {
        headers: browser(
          `access_token=${winner.cookies["access_token"]}; refresh_token=${winner.cookies["refresh_token"]}`,
        ),
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, 'id="saved-searches"');
      assert.include(page.body, "Listings No pets");
    }),
  );

  it.effect("does not retry a token a previous request already spent", () =>
    Effect.gen(function* () {
      const session = yield* signIn("rotation-abandoned");
      const rotated = yield* call("/search", { headers: browser(staleAccess(session)) });
      assert.strictEqual(rotated.status, 200, rotated.body);
      assert.notStrictEqual(rotated.cookies["refresh_token"], session.refresh);

      const page = yield* call("/search", { headers: browser(staleAccess(session)) });
      assert.strictEqual(page.status, 200, page.body);
      assert.notInclude(page.body, 'id="saved-searches"');
      assert.isUndefined(page.cookies["refresh_token"]);
    }),
  );
});
