import { asObject, register, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * These tests drive the real private router - `AuthMiddleware`, the listing
 * handlers, `ListingService`, and the repository - through the shared harness
 * in `test/support/api.ts`, which owns how the app is assembled and called.
 * Users are registered through the public auth endpoint, so the cookies these
 * tests present are the same signed access tokens the app issues.
 */

// Registered once per file; every test then creates the listings it needs.
const users = await Effect.runPromise(
  Effect.gen(function* () {
    const owner = yield* register("owner");
    const other = yield* register("other");
    return { owner, other };
  }),
);

let priceCounter = 0;
const uniquePriceMinor = () => 100_000 + (priceCounter += 1) * 111;

const listingPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: "room",
  title: "Sunny room near the port",
  description: "A quiet room with a balcony",
  priceMinor: uniquePriceMinor(),
  regionCode: "attica",
  sizeSqm: 30,
  furnished: 1,
  ensuite: 0,
  smoking: 0,
  pets: 1,
  ...overrides,
});

const createDraft = (
  user: { readonly id: string; readonly cookie: string },
  overrides: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/listings", {
      cookie: user.cookie,
      payload: listingPayload(overrides),
    });
    assert.strictEqual(response.status, 200, `create draft: ${response.body}`);
    return asObject(response.json);
  });

describe("POST /api/listings", () => {
  it.effect("creates a draft owned by the caller and never a published listing", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner, {
        title: "  Trimmed title  ",
        lat: 37.98,
        lng: 23.72,
      });

      assert.strictEqual(listing.status, "draft");
      assert.strictEqual(listing.ownerId, users.owner.id);
      assert.strictEqual(listing.title, "Trimmed title");
      assert.strictEqual(listing.kind, "room");
      assert.strictEqual(listing.regionCode, "attica");
      assert.strictEqual(listing.lat, 37.98);
      assert.strictEqual(listing.lng, 23.72);
      // The row schema's flags are bits, so they travel as 0/1 on both sides.
      assert.strictEqual(listing.furnished, 1);
      assert.strictEqual(listing.ensuite, 0);
      assert.isNull(listing.publishedAt);
    }),
  );

  it.effect("rejects an unauthenticated create with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("POST", "/api/listings", {
        payload: listingPayload(),
      });
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("rejects a blank, oversized, or negatively priced listing with a 400", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Record<string, unknown>> = [
        { title: "   " },
        { title: "x".repeat(121) },
        { priceMinor: -1 },
      ];
      for (const overrides of cases) {
        const response = yield* send("POST", "/api/listings", {
          cookie: users.owner.cookie,
          payload: listingPayload(overrides),
        });
        assert.strictEqual(response.status, 400, JSON.stringify(overrides));
      }
    }),
  );

  it.effect("rejects coordinates outside the Greek box with a 422", () =>
    Effect.gen(function* () {
      const valencia = yield* send("POST", "/api/listings", {
        cookie: users.owner.cookie,
        payload: listingPayload({ lat: 39.47, lng: -0.38 }),
      });
      assert.strictEqual(valencia.status, 422);

      // Half a pair is a bad request, not a location problem.
      const halfPair = yield* send("POST", "/api/listings", {
        cookie: users.owner.cookie,
        payload: listingPayload({ lat: 37.98 }),
      });
      assert.strictEqual(halfPair.status, 400);
    }),
  );
});

describe("PATCH /api/listings/:id", () => {
  it.effect("updates the owner's listing and only the fields it was sent", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      const id = listing.id;

      const response = yield* send("PATCH", `/api/listings/${id}`, {
        cookie: users.owner.cookie,
        payload: { title: "Renamed room", priceMinor: 62_000 },
      });
      assert.strictEqual(response.status, 200, response.body);
      const updated = asObject(response.json);
      assert.strictEqual(updated.title, "Renamed room");
      assert.strictEqual(updated.priceMinor, 62_000);
      // Untouched fields keep their stored values.
      assert.strictEqual(updated.regionCode, listing.regionCode);
      assert.strictEqual(updated.sizeSqm, listing.sizeSqm);
      assert.strictEqual(updated.status, "draft");
    }),
  );

  it.effect("answers 403 for another owner's listing and 404 for a missing one", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);

      const foreign = yield* send("PATCH", `/api/listings/${listing.id}`, {
        cookie: users.other.cookie,
        payload: { title: "Hijacked" },
      });
      assert.strictEqual(foreign.status, 403);

      const missing = yield* send("PATCH", "/api/listings/999999", {
        cookie: users.owner.cookie,
        payload: { title: "Nowhere" },
      });
      assert.strictEqual(missing.status, 404);
    }),
  );

  it.effect("rejects invalid input and out-of-Greece coordinates", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);

      for (const payload of [{ title: "" }, { title: "x".repeat(121) }, { priceMinor: -1 }]) {
        const response = yield* send("PATCH", `/api/listings/${listing.id}`, {
          cookie: users.owner.cookie,
          payload,
        });
        assert.strictEqual(response.status, 400, JSON.stringify(payload));
      }

      const outside = yield* send("PATCH", `/api/listings/${listing.id}`, {
        cookie: users.owner.cookie,
        payload: { lat: 35.9, lng: 14.51 },
      });
      assert.strictEqual(outside.status, 422);
    }),
  );

  it.effect("rejects an unauthenticated update with a 401", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      const response = yield* send("PATCH", `/api/listings/${listing.id}`, {
        payload: { title: "Anonymous" },
      });
      assert.strictEqual(response.status, 401);
    }),
  );
});

describe("POST /api/listings/:id/publish and /unlist", () => {
  it.effect("publishes a draft, unlists it, and relists it", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      const id = listing.id;

      const published = yield* send("POST", `/api/listings/${id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(published.status, 200, published.body);
      const publishedBody = asObject(published.json);
      assert.strictEqual(publishedBody.status, "published");
      assert.isNumber(publishedBody.publishedAt);

      const unlisted = yield* send("POST", `/api/listings/${id}/unlist`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(unlisted.status, 200, unlisted.body);
      assert.strictEqual(asObject(unlisted.json).status, "unpublished");

      // Unlisting is reversible and keeps the listing.
      const relisted = yield* send("POST", `/api/listings/${id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(relisted.status, 200, relisted.body);
      assert.strictEqual(asObject(relisted.json).status, "published");
    }),
  );

  it.effect("answers 409 for an illegal transition", () =>
    Effect.gen(function* () {
      const draft = yield* createDraft(users.owner);
      const unlistingDraft = yield* send("POST", `/api/listings/${draft.id}/unlist`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(unlistingDraft.status, 409);

      const published = yield* send("POST", `/api/listings/${draft.id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(published.status, 200);

      const republishing = yield* send("POST", `/api/listings/${draft.id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(republishing.status, 409);
    }),
  );

  it.effect("answers 403 for another owner and 404 for a missing listing", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);

      const foreignPublish = yield* send("POST", `/api/listings/${listing.id}/publish`, {
        cookie: users.other.cookie,
      });
      assert.strictEqual(foreignPublish.status, 403);

      const missingUnlist = yield* send("POST", "/api/listings/999999/unlist", {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(missingUnlist.status, 404);
    }),
  );

  it.effect("rejects unauthenticated transitions with a 401", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      for (const action of ["publish", "unlist"]) {
        const response = yield* send("POST", `/api/listings/${listing.id}/${action}`);
        assert.strictEqual(response.status, 401, action);
      }
    }),
  );
});
