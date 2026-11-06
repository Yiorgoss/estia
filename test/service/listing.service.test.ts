import { ListingId, UserId } from "@/db/schema/brands";
import { CreateListingInput, ListingPageRequest } from "@/db/schema/Listing";
import { ListingRepositoryLive } from "@/repos/listing.repo";
import { ListingService, ListingServiceLive } from "@/services/listing.service";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { insertListing, insertUser } from "../support/seed";
import { TestSqlLive } from "../support/sql";

const ownerId = (value: string) => Schema.decodeSync(UserId)(value);
const listingId = (value: number) => Schema.decodeSync(ListingId)(value);

const RepositoriesLive = ListingRepositoryLive.pipe(Layer.provide(TestSqlLive));

const TestLive = Layer.merge(ListingServiceLive.pipe(Layer.provide(RepositoriesLive)), TestSqlLive);

const AT = 1_700_000_000_000;

// Every test shares one database, so each seeds its own owners and ids.
const tagOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect)
    .pipe(Effect.map((error) => (error as { readonly _tag?: string })._tag))
    .pipe(Effect.orElseSucceed(() => "success"));

const draft = (overrides: Partial<typeof CreateListingInput.Type> = {}) => ({
  kind: "room" as const,
  title: "Sunny room",
  priceMinor: 45_000,
  regionCode: "attica" as const,
  ...overrides,
});

layer(TestLive, { concurrent: false })("ListingService", (it) => {
  it.effect("createDraft always creates a draft owned by the caller", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-create", "svc-create@test.local");
      const service = yield* ListingService;

      const created = yield* service.createDraft(
        ownerId("u-svc-create"),
        draft({ lat: 37.98, lng: 23.72, sizeSqm: 18 }),
      );
      assert.strictEqual(created.status, "draft");
      assert.strictEqual(created.ownerId, "u-svc-create");
      assert.isNull(created.publishedAt);
      assert.strictEqual(created.lat, 37.98);
    }),
  );

  it.effect("createDraft rejects a half coordinate pair with a 400", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-half", "svc-half@test.local");
      const service = yield* ListingService;

      assert.strictEqual(
        yield* tagOf(service.createDraft(ownerId("u-svc-half"), draft({ lat: 37.98 }))),
        "ListingValidationError",
      );
      assert.strictEqual(
        yield* tagOf(service.createDraft(ownerId("u-svc-half"), draft({ lng: 23.72 }))),
        "ListingValidationError",
      );
    }),
  );

  it.effect("createDraft rejects coordinates outside the coarse Greek box with a 422", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-geo", "svc-geo@test.local");
      const service = yield* ListingService;

      // Valencia and Valletta are far outside the box.
      assert.strictEqual(
        yield* tagOf(service.createDraft(ownerId("u-svc-geo"), draft({ lat: 39.47, lng: -0.38 }))),
        "ListingLocationOutOfGreeceError",
      );
      assert.strictEqual(
        yield* tagOf(service.createDraft(ownerId("u-svc-geo"), draft({ lat: 35.9, lng: 14.51 }))),
        "ListingLocationOutOfGreeceError",
      );
    }),
  );

  it.effect("createDraft accepts coordinates inside the box and the region is the real gate", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-box", "svc-box@test.local");
      const service = yield* ListingService;

      // The box is deliberately coarse: Istanbul (41.01, 28.98) is inside it,
      // so a foreign point is only stopped by the required region, never by
      // coordinates. This test records that limitation instead of pretending
      // the box is a boundary.
      const created = yield* service.createDraft(
        ownerId("u-svc-box"),
        draft({ lat: 41.01, lng: 28.98, regionCode: "central_macedonia" }),
      );
      assert.strictEqual(created.lat, 41.01);
      assert.strictEqual(created.lng, 28.98);
    }),
  );

  it.effect("createDraft and updateListing trim the title and reject a blank one with a 400", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-title", "svc-title@test.local");
      const service = yield* ListingService;

      assert.strictEqual(
        yield* tagOf(service.createDraft(ownerId("u-svc-title"), draft({ title: "   " }))),
        "ListingValidationError",
      );
      assert.strictEqual(
        yield* tagOf(service.createDraft(ownerId("u-svc-title"), draft({ title: "\t\n " }))),
        "ListingValidationError",
      );

      const created = yield* service.createDraft(
        ownerId("u-svc-title"),
        draft({ title: "  Sunny room  " }),
      );
      assert.strictEqual(created.title, "Sunny room");

      const updated = yield* service.updateListing(ownerId("u-svc-title"), created.id, {
        title: "  Bigger room ",
      });
      assert.strictEqual(updated.title, "Bigger room");

      assert.strictEqual(
        yield* tagOf(service.updateListing(ownerId("u-svc-title"), created.id, { title: "   " })),
        "ListingValidationError",
      );
    }),
  );

  it.effect("getOwn and getPublic draw the ownership and visibility lines", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-own", "svc-own@test.local");
      yield* insertUser("u-svc-own-other", "svc-own-other@test.local");
      yield* insertListing(5101, "u-svc-own", { status: "draft" });
      yield* insertListing(5102, "u-svc-own", { status: "published" });
      yield* insertListing(5103, "u-svc-own", { status: "unpublished" });

      const service = yield* ListingService;

      const own = yield* service.getOwn(ownerId("u-svc-own"), listingId(5101));
      assert.strictEqual(own.id, 5101);

      // A logged-in non-owner learns the listing exists but not its content.
      assert.strictEqual(
        yield* tagOf(service.getOwn(ownerId("u-svc-own-other"), listingId(5101))),
        "ListingNotOwnedError",
      );
      assert.strictEqual(
        yield* tagOf(service.getOwn(ownerId("u-svc-own"), listingId(9_999_999))),
        "ListingNotFoundError",
      );

      // Public reads only ever see published listings; drafts and unlisted
      // listings are indistinguishable from a missing id.
      assert.strictEqual((yield* service.getPublic(listingId(5102))).id, 5102);
      assert.strictEqual(yield* tagOf(service.getPublic(listingId(5101))), "ListingNotFoundError");
      assert.strictEqual(yield* tagOf(service.getPublic(listingId(5103))), "ListingNotFoundError");
    }),
  );

  it.effect("publish and unlist follow the transition table and the 409 rule", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-status", "svc-status@test.local");
      yield* insertUser("u-svc-status-other", "svc-status-other@test.local");
      yield* insertListing(5201, "u-svc-status", { status: "draft", createdAt: AT });
      yield* insertListing(5202, "u-svc-status", { status: "published", createdAt: AT });

      const service = yield* ListingService;

      // A draft cannot be unlisted, and a published listing cannot be
      // re-published.
      assert.strictEqual(
        yield* tagOf(service.unlist(ownerId("u-svc-status"), listingId(5201))),
        "InvalidListingTransitionError",
      );
      assert.strictEqual(
        yield* tagOf(service.publish(ownerId("u-svc-status"), listingId(5202))),
        "InvalidListingTransitionError",
      );
      // Only the owner may transition.
      assert.strictEqual(
        yield* tagOf(service.publish(ownerId("u-svc-status-other"), listingId(5201))),
        "ListingNotOwnedError",
      );
      assert.strictEqual(
        yield* tagOf(service.publish(ownerId("u-svc-status"), listingId(9_999_999))),
        "ListingNotFoundError",
      );

      const published = yield* service.publish(ownerId("u-svc-status"), listingId(5201));
      assert.strictEqual(published.status, "published");
      assert.isNotNull(published.publishedAt);

      const unlisted = yield* service.unlist(ownerId("u-svc-status"), listingId(5201));
      assert.strictEqual(unlisted.status, "unpublished");
      // Unlisting is reversible: relisting works and keeps the listing.
      const relisted = yield* service.publish(ownerId("u-svc-status"), listingId(5201));
      assert.strictEqual(relisted.status, "published");
      assert.strictEqual(relisted.id, 5201);
    }),
  );

  it.effect("updateListing is owner scoped and validates the merged coordinate pair", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-update", "svc-update@test.local");
      yield* insertUser("u-svc-update-other", "svc-update-other@test.local");
      yield* insertListing(5301, "u-svc-update", {
        title: "Before",
        lat: 37.98,
        lng: 23.72,
        createdAt: AT,
      });

      const service = yield* ListingService;

      assert.strictEqual(
        yield* tagOf(
          service.updateListing(ownerId("u-svc-update-other"), listingId(5301), {
            title: "Hijacked",
          }),
        ),
        "ListingNotOwnedError",
      );
      assert.strictEqual(
        yield* tagOf(
          service.updateListing(ownerId("u-svc-update"), listingId(9_999_999), { title: "Nope" }),
        ),
        "ListingNotFoundError",
      );

      // A partial update is merged with the stored row before validation, so
      // moving only the longitude is fine.
      const moved = yield* service.updateListing(ownerId("u-svc-update"), listingId(5301), {
        lng: 24.0,
      });
      assert.strictEqual(moved.lat, 37.98);
      assert.strictEqual(moved.lng, 24.0);

      // Clearing one half of the pair is rejected even though the request only
      // carried that half.
      assert.strictEqual(
        yield* tagOf(
          service.updateListing(ownerId("u-svc-update"), listingId(5301), { lat: null }),
        ),
        "ListingValidationError",
      );

      // Clearing both together is allowed.
      const cleared = yield* service.updateListing(ownerId("u-svc-update"), listingId(5301), {
        lat: null,
        lng: null,
        title: "After",
      });
      assert.isNull(cleared.lat);
      assert.isNull(cleared.lng);
      assert.strictEqual(cleared.title, "After");
    }),
  );

  it.effect("listMine is owner scoped and search only sees published listings", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-feed", "svc-feed@test.local");
      yield* insertUser("u-svc-feed-other", "svc-feed-other@test.local");
      yield* insertListing(5401, "u-svc-feed", { status: "draft", createdAt: AT + 1_000 });
      yield* insertListing(5402, "u-svc-feed", {
        status: "published",
        regionCode: "thessaly",
        sizeSqm: 40,
        createdAt: AT + 2_000,
      });
      yield* insertListing(5403, "u-svc-feed-other", {
        status: "published",
        regionCode: "thessaly",
        sizeSqm: 90,
        createdAt: AT + 3_000,
      });

      const service = yield* ListingService;

      const mine = yield* service.listMine(ownerId("u-svc-feed"), { limit: 50 });
      const mineIds = mine.items.map((item): number => item.id);
      assert.includeMembers(mineIds, [5401, 5402]);
      assert.notInclude(mineIds, 5403);
      assert.isTrue(mine.items.every((item) => item.ownerId === "u-svc-feed"));

      const feed = yield* service.search({ regionCode: "thessaly" }, { limit: 50 });
      assert.deepStrictEqual(
        feed.items.map((item) => item.id),
        [5403, 5402],
      );

      const small = yield* service.search(
        { regionCode: "thessaly", maxSizeSqm: 40 },
        { limit: 50 },
      );
      assert.deepStrictEqual(
        small.items.map((item) => item.id),
        [5402],
      );
    }),
  );

  it("the request schemas decode valid input and reject malformed values", () => {
    const decodeCreate = Schema.decodeUnknownSync(CreateListingInput);

    for (const kind of ["room", "whole_property", "room_wanted"] as const) {
      const decoded = decodeCreate({
        kind,
        title: `${kind} ad`,
        priceMinor: 0,
        regionCode: "attica",
      });
      assert.strictEqual(decoded.kind, kind);
    }

    assert.throws(() =>
      decodeCreate({ kind: "room", title: "X", priceMinor: -1, regionCode: "attica" }),
    );
    assert.throws(() =>
      decodeCreate({ kind: "room", title: "x".repeat(121), priceMinor: 1, regionCode: "attica" }),
    );
    assert.throws(() =>
      decodeCreate({ kind: "room", title: "", priceMinor: 1, regionCode: "attica" }),
    );
    assert.throws(() =>
      decodeCreate({
        kind: "room",
        title: "X",
        priceMinor: 1,
        regionCode: "atlantis" as never,
      }),
    );
    assert.throws(() =>
      decodeCreate({
        kind: "castaway",
        title: "X",
        priceMinor: 1,
        regionCode: "attica",
      } as never),
    );

    // Paging: limit defaults to 20 and is capped at 50.
    const decodePage = Schema.decodeUnknownSync(ListingPageRequest);
    assert.strictEqual(decodePage({}).limit, 20);
    assert.strictEqual(decodePage({ limit: 50 }).limit, 50);
    assert.throws(() => decodePage({ limit: 51 }));
    assert.throws(() => decodePage({ limit: 0 }));
  });
});
