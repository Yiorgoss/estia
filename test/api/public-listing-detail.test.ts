import { asObject, call, register, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The unauthenticated single-listing read, driven through the real public
 * router against the in-memory database. A published listing must expose the
 * same narrow projection the search feed already exposes, and a draft, an
 * unlisted listing, and an unknown id must all answer 404, so unpublished ids
 * cannot be probed.
 */

const publicKeys = [
  "availableFrom",
  "currency",
  "description",
  "ensuite",
  "furnished",
  "id",
  "kind",
  "pets",
  "photos",
  "priceMinor",
  "publishedAt",
  "regionCode",
  "sizeSqm",
  "smoking",
  "thumbnailUrl",
  "title",
];

// Nothing an owner or a map needs may travel on the public surface.
const privateKeys = ["ownerId", "status", "lat", "lng", "createdAt", "updatedAt"];

const owner = await Effect.runPromise(register("public-detail-owner"));

let priceCounter = 0;
const uniquePriceMinor = () => 300_000 + (priceCounter += 1) * 211;

const createListing = (overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/listings", {
      cookie: owner.cookie,
      payload: {
        kind: "room",
        title: "Seaside studio",
        description: "Steps from the beach",
        priceMinor: uniquePriceMinor(),
        regionCode: "crete",
        sizeSqm: 42,
        furnished: 1,
        ensuite: 0,
        smoking: 0,
        pets: 1,
        ...overrides,
      },
    });
    assert.strictEqual(response.status, 200, `create listing: ${response.body}`);
    const listing = asObject(response.json);
    assert.strictEqual(listing.status, "draft");
    return listing;
  });

const transition = (action: "publish" | "unlist", id: unknown) =>
  Effect.gen(function* () {
    const response = yield* send("POST", `/api/listings/${String(id)}/${action}`, {
      cookie: owner.cookie,
    });
    assert.strictEqual(response.status, 200, `${action} listing: ${response.body}`);
    return response;
  });

const getListing = (id: unknown) => call(`/api/listings/${String(id)}`);
const getListingPage = (id: unknown) => call(`/listings/${String(id)}`);

describe("GET /api/listings/:id", () => {
  it.effect("serves a published listing with only the public fields", () =>
    Effect.gen(function* () {
      const created = yield* createListing({
        title: "Seaside studio in Chania",
        description: "Steps from the beach",
        priceMinor: uniquePriceMinor(),
        availableFrom: Date.UTC(2026, 2, 1),
      });
      const id = created.id;
      yield* transition("publish", id);

      const response = yield* getListing(id);
      assert.strictEqual(response.status, 200, response.body);
      const body = asObject(response.json);

      assert.deepStrictEqual(Object.keys(body).sort(), publicKeys);
      for (const key of privateKeys) {
        assert.isFalse(key in body, `public listing exposed ${key}`);
      }
      assert.strictEqual(body.id, id);
      assert.strictEqual(body.title, "Seaside studio in Chania");
      assert.strictEqual(body.description, "Steps from the beach");
      assert.strictEqual(body.kind, "room");
      assert.strictEqual(body.regionCode, "crete");
      assert.strictEqual(body.sizeSqm, 42);
      assert.strictEqual(body.currency, "EUR");
      assert.isNumber(body.priceMinor);
      assert.isNumber(body.publishedAt);
      // The row schema's flags are bits, so they travel as 0/1 on both sides.
      assert.strictEqual(body.furnished, 1);
      assert.strictEqual(body.ensuite, 0);
      assert.strictEqual(body.smoking, 0);
      assert.strictEqual(body.pets, 1);

      // The detail route is a second segment, so the bare search route still
      // answers the feed, and a listing reads exactly the same on both.
      const feed = yield* call(`/api/listings?minPriceMinor=${String(body.priceMinor)}`);
      assert.strictEqual(feed.status, 200, feed.body);
      const items = (feed.json as { items: ReadonlyArray<Record<string, unknown>> }).items ?? [];
      const feedItem = items.find((item) => item.id === id);
      assert.deepStrictEqual(feedItem, body);
    }),
  );

  it.effect("answers 404 for a draft, an unlisted listing, and an unknown id", () =>
    Effect.gen(function* () {
      const draft = yield* createListing({ title: "Still a draft" });

      const unlisted = yield* createListing({ title: "Was published once" });
      yield* transition("publish", unlisted.id);
      yield* transition("unlist", unlisted.id);

      // A published listing is readable, so the 404s below are about visibility
      // rather than a route that never resolves.
      const visible = yield* createListing({ title: "Still published" });
      yield* transition("publish", visible.id);
      assert.strictEqual((yield* getListing(visible.id)).status, 200);

      for (const id of [draft.id, unlisted.id, 9_999_999]) {
        const response = yield* getListing(id);
        assert.strictEqual(response.status, 404, `id ${String(id)}: ${response.body}`);
        assert.notInclude(response.body, "ownerId");
      }
    }),
  );
});

describe("GET /listings/:id", () => {
  it.effect("renders a published listing with its metadata and a way back to search", () =>
    Effect.gen(function* () {
      const created = yield* createListing({
        title: "Sunny flat in Rethymno",
        description: "Two rooms and a balcony",
      });
      yield* transition("publish", created.id);

      const response = yield* getListingPage(created.id);
      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, "Sunny flat in Rethymno");
      assert.include(response.body, "Two rooms and a balcony");
      assert.include(response.body, "Crete");
      assert.include(response.body, "<title>Sunny flat in Rethymno - Crete</title>");
      assert.include(response.body, 'name="description"');
      assert.include(response.body, 'href="/search"');
    }),
  );

  it.effect("renders the not-found page for a draft, an unlisted listing, and an unknown id", () =>
    Effect.gen(function* () {
      const draft = yield* createListing({ title: "Hidden draft" });

      const unlisted = yield* createListing({ title: "Hidden unlisted" });
      yield* transition("publish", unlisted.id);
      yield* transition("unlist", unlisted.id);

      for (const id of [draft.id, unlisted.id, 9_999_999, "not-an-id"]) {
        const response = yield* getListingPage(id);
        assert.strictEqual(response.status, 404, `id ${String(id)}: ${response.body}`);
        assert.include(response.body, "Listing not found");
        assert.include(response.body, 'href="/search"');
        assert.notInclude(response.body, "Hidden draft");
        assert.notInclude(response.body, "Hidden unlisted");
      }
    }),
  );
});
