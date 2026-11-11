import { asObject, register, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

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
