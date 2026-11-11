import { SavedSearchSchema } from "@/db/schema/SavedSearch";
import { savedSearchResultsHref } from "@/frontend/saved-search";
import { asObject, call, form, register, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

/*
 * The saved-search API, driven through the real private router: the cookie is a
 * signed access token from the real registration endpoint, and the rows are read
 * back through the list endpoint the results page uses.
 */

const users = await Effect.runPromise(
  Effect.gen(function* () {
    const owner = yield* register("saved-owner");
    const other = yield* register("saved-other");
    return { owner, other };
  }),
);

const criteria = () => ({
  name: "Balcony rooms in Attica",
  query: "balcony",
  kind: "room",
  regionCode: "attica",
  minPriceMinor: 40_000,
  maxPriceMinor: 80_000,
  minSizeSqm: 20,
  maxSizeSqm: 50,
  furnished: true,
  pets: false,
  availableFrom: Date.UTC(2026, 2, 1),
});

const create = (user: { readonly cookie: string }, payload: Record<string, unknown>) =>
  send("POST", "/api/saved-searches", { cookie: user.cookie, payload });

const list = (user: { readonly cookie: string }) =>
  send("GET", "/api/saved-searches", { cookie: user.cookie });

const remove = (user: { readonly cookie: string }, id: unknown) =>
  send("DELETE", `/api/saved-searches/${String(id)}`, { cookie: user.cookie });

/*
 * The browser's own paths. A save is the search form's htmx post, so it carries
 * the htmx marker and the criteria as form fields; the session is the cookie
 * pair a browser holds.
 */
const PASSWORD = "correct horse battery staple";

interface BrowserSession {
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
    return { access: response.cookies["access_token"], refresh: response.cookies["refresh_token"] };
  });

const savedSearches = (cookie: string) =>
  Effect.gen(function* () {
    const response = yield* send("GET", "/api/saved-searches", { cookie });
    assert.strictEqual(response.status, 200, response.body);
    const items = asObject(response.json)["items"];
    assert.isArray(items);
    return (items as ReadonlyArray<unknown>).map((item) =>
      Schema.decodeUnknownSync(SavedSearchSchema)(item),
    );
  });

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

const criteriaOf = (saved: typeof SavedSearchSchema.Type) => ({
  query: saved.query,
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

describe("POST /api/saved-searches", () => {
  it.effect("stores the criteria and returns the row the results page can re-run", () =>
    Effect.gen(function* () {
      const response = yield* create(users.owner, criteria());
      assert.strictEqual(response.status, 200, response.body);

      const saved = asObject(response.json);
      assert.strictEqual(saved.name, "Balcony rooms in Attica");
      assert.strictEqual(saved.userId, users.owner.id);
      assert.strictEqual(saved.query, "balcony");
      assert.strictEqual(saved.kind, "room");
      assert.strictEqual(saved.regionCode, "attica");
      assert.strictEqual(saved.minPriceMinor, 40_000);
      assert.strictEqual(saved.maxPriceMinor, 80_000);
      assert.strictEqual(saved.minSizeSqm, 20);
      assert.strictEqual(saved.maxSizeSqm, 50);
      assert.strictEqual(saved.furnished, true);
      assert.isNull(saved.ensuite);
      assert.strictEqual(saved.pets, false);
      assert.strictEqual(saved.availableFrom, Date.UTC(2026, 2, 1));
      assert.isNumber(saved.createdAt);
    }),
  );

  it.effect("names an unnamed search after its criteria", () =>
    Effect.gen(function* () {
      const response = yield* create(users.owner, { regionCode: "crete" });
      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(asObject(response.json).name, "Listings in Crete");
    }),
  );

  it.effect("trims a supplied name", () =>
    Effect.gen(function* () {
      const response = yield* create(users.owner, { name: "  Trimmed name  " });
      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(asObject(response.json).name, "Trimmed name");
    }),
  );

  it.effect("rejects an inverted range", () =>
    Effect.gen(function* () {
      const response = yield* create(users.owner, {
        minPriceMinor: 90_000,
        maxPriceMinor: 10_000,
      });
      assert.strictEqual(response.status, 400);
    }),
  );

  it.effect("rejects an unauthenticated create with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("POST", "/api/saved-searches", { payload: criteria() });
      assert.strictEqual(response.status, 401);
    }),
  );
});

describe("GET /api/saved-searches", () => {
  it.effect("lists only the caller's saved searches, newest first", () =>
    Effect.gen(function* () {
      const created = yield* create(users.owner, { name: "Newest" });
      assert.strictEqual(created.status, 200, created.body);
      yield* create(users.other, { name: "Someone else's" });

      const response = yield* list(users.owner);
      assert.strictEqual(response.status, 200, response.body);
      const items = asObject(response.json)["items"];
      assert.isArray(items);
      const names = (items as ReadonlyArray<Record<string, unknown>>).map((item) => item["name"]);
      assert.notInclude(names, "Someone else's");
      assert.include(names, "Newest");
    }),
  );

  it.effect("rejects an unauthenticated list with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("GET", "/api/saved-searches");
      assert.strictEqual(response.status, 401);
    }),
  );
});

describe("DELETE /api/saved-searches/:id", () => {
  it.effect("deletes the caller's own saved search", () =>
    Effect.gen(function* () {
      const created = yield* create(users.owner, { name: "To delete" });
      assert.strictEqual(created.status, 200, created.body);
      const id = asObject(created.json)["id"];

      const deleted = yield* remove(users.owner, id);
      assert.strictEqual(deleted.status, 204, deleted.body);

      const after = yield* list(users.owner);
      const items = asObject(after.json)["items"] as ReadonlyArray<Record<string, unknown>>;
      assert.notInclude(
        items.map((item) => item["id"]),
        id,
      );

      // A second delete has nothing left to remove.
      const again = yield* remove(users.owner, id);
      assert.strictEqual(again.status, 404);
    }),
  );

  it.effect("never deletes another account's saved search", () =>
    Effect.gen(function* () {
      const created = yield* create(users.owner, { name: "Owner only" });
      assert.strictEqual(created.status, 200, created.body);
      const id = asObject(created.json)["id"];

      const refused = yield* remove(users.other, id);
      assert.strictEqual(refused.status, 404);

      const after = yield* list(users.owner);
      const ids = (asObject(after.json)["items"] as ReadonlyArray<Record<string, unknown>>).map(
        (item) => item["id"],
      );
      assert.include(ids, id);
    }),
  );

  it.effect("rejects an unauthenticated delete with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("DELETE", "/api/saved-searches/1");
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("treats a malformed id as no such saved search", () =>
    Effect.gen(function* () {
      const response = yield* remove(users.owner, "not-an-id");
      assert.strictEqual(response.status, 404);
    }),
  );
});

describe("the browser's saved-search routes", () => {
  it.effect("renders an htmx save's expired-session error in the panel", () =>
    Effect.gen(function* () {
      const session = yield* signIn("htmx-expired-save");

      const response = yield* browserSave(staleAccess(session), { pets: "false" });
      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, 'id="saved-searches"');
      assert.include(response.body, "Sign in to save a search.");

      // The middleware renewed the session on the same response, so the person
      // can try again; nothing was saved silently.
      const listed = yield* savedSearches(`access_token=${response.cookies["access_token"]}`);
      assert.deepStrictEqual(listed, []);
    }),
  );

  it.effect("keeps the 401 for a save that navigates without htmx", () =>
    Effect.gen(function* () {
      const session = yield* signIn("forms-expired-save");

      const response = yield* call(
        "/search/saved",
        form(
          { method: "POST", headers: { cookie: staleAccess(session) } },
          { pets: "false" },
        ),
      );
      assert.strictEqual(response.status, 401, response.body);
      assert.strictEqual(response.body, "Sign in to save a search.");
    }),
  );

  it.effect("renders an htmx delete's expired-session error in the panel", () =>
    Effect.gen(function* () {
      const session = yield* signIn("htmx-expired-delete");
      const created = yield* send("POST", "/api/saved-searches", {
        cookie: `access_token=${session.access}`,
        payload: { name: "Kept after a stale delete" },
      });
      assert.strictEqual(created.status, 200, created.body);
      const id = asObject(created.json)["id"];

      const response = yield* call(
        `/search/saved/${String(id)}/delete`,
        form(
          {
            method: "POST",
            headers: { cookie: staleAccess(session), "hx-request": "true" },
          },
          {},
        ),
      );
      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, "Sign in to delete a saved search.");

      const listed = yield* savedSearches(`access_token=${response.cookies["access_token"]}`);
      assert.include(
        listed.map((saved) => saved.id),
        id,
      );
    }),
  );

  it.effect("renders a cross-site refusal in the panel for htmx", () =>
    Effect.gen(function* () {
      const created = yield* create(users.owner, { name: "Cross-site target" });
      assert.strictEqual(created.status, 200, created.body);
      const id = asObject(created.json)["id"];

      const save = yield* browserSave(
        users.owner.cookie,
        { pets: "false" },
        { origin: "https://evil.example" },
      );
      assert.strictEqual(save.status, 200, save.body);
      assert.include(save.body, 'id="saved-searches"');
      assert.include(save.body, "can only be submitted from this site");

      const removeResponse = yield* call(
        `/search/saved/${String(id)}/delete`,
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

      const after = yield* list(users.owner);
      const ids = (asObject(after.json)["items"] as ReadonlyArray<Record<string, unknown>>).map(
        (item) => item["id"],
      );
      assert.include(ids, id);
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
        query: "balcony",
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

      const [stored] = yield* savedSearches(users.owner.cookie);
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

      const [again] = yield* savedSearches(users.owner.cookie);
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
      const created = yield* send("POST", "/api/saved-searches", {
        cookie: `access_token=${session.access}`,
        payload: { name: "Returned later", pets: false },
      });
      assert.strictEqual(created.status, 200, created.body);

      const page = yield* call("/search", {
        headers: {
          "user-agent": "estia-tests",
          cookie: `access_token=an.expired.token; refresh_token=${session.refresh}`,
        },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, 'id="saved-searches"');
      assert.include(page.body, "Returned later");

      const access = page.cookies["access_token"];
      const refresh = page.cookies["refresh_token"];
      assert.isDefined(access);
      assert.isDefined(refresh);
      assert.notStrictEqual(access, "an.expired.token");
      assert.notStrictEqual(refresh, session.refresh);

      const listed = yield* send("GET", "/api/saved-searches", {
        cookie: `access_token=${access}`,
      });
      assert.strictEqual(listed.status, 200, listed.body);
      const names = (
        asObject(listed.json)["items"] as ReadonlyArray<Record<string, unknown>>
      ).map((item) => item["name"]);
      assert.include(names, "Returned later");

      const results = yield* call("/search/results", {
        headers: {
          "user-agent": "estia-tests",
          cookie: `access_token=an.expired.token; refresh_token=${refresh}`,
        },
      });
      assert.strictEqual(results.status, 200, results.body);
      assert.include(results.body, 'hx-post="/search/saved"');
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
});
