import { ListingId, UserId } from "@/db/schema/brands";
import {
  GreekRegionCodes,
  ListingCursor,
  ListingPageRequest,
  UpdateListingInput,
} from "@/db/schema/Listing";
import { ListingRepository, ListingRepositoryLive } from "@/repos/listing.repo";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { insertListing, insertUser } from "../support/seed";
import { TestSqlLive } from "../support/sql";

const ownerId = (value: string) => Schema.decodeSync(UserId)(value);
const listingId = (value: number) => Schema.decodeSync(ListingId)(value);

const TestLive = Layer.merge(ListingRepositoryLive.pipe(Layer.provide(TestSqlLive)), TestSqlLive);

// Every test shares one in-memory database, so each test seeds its own owners
// and asserts over the ids it created.
const page = (limit: number): typeof ListingPageRequest.Type => ({ limit });

const cursorOf = (value: typeof ListingCursor.Type | null | undefined): typeof ListingCursor.Type =>
  Schema.decodeSync(ListingCursor)(Option.getOrThrow(Option.fromNullishOr(value)));

// `Clock.currentTimeMillis` reads 0 under `it.effect` (the harness runs on a
// TestClock at epoch), so tests that care about a stored timestamp set the clock
// explicitly and tests that care about ordering seed explicit `created_at`s.
const AT = 1_700_000_000_000;

layer(TestLive, { concurrent: false })("ListingRepository", (it) => {
  it.effect("create inserts a draft and findById decodes it", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-create", "listing-create@test.local");
      yield* TestClock.setTime(AT);

      const repo = yield* ListingRepository;
      const created = yield* repo.create(ownerId("u-listing-create"), {
        kind: "whole_property",
        title: "Two bedroom flat near the port",
        description: "Sea view",
        priceMinor: 95_000,
        regionCode: "crete",
        lat: 35.34,
        lng: 25.13,
        sizeSqm: 74,
        availableFrom: new Date(AT + 86_400_000),
        furnished: true,
        ensuite: false,
        smoking: false,
        pets: true,
      });

      assert.strictEqual(created.status, "draft");
      assert.strictEqual(created.kind, "whole_property");
      assert.strictEqual(created.ownerId, "u-listing-create");
      assert.strictEqual(created.title, "Two bedroom flat near the port");
      assert.strictEqual(created.description, "Sea view");
      assert.strictEqual(created.priceMinor, 95_000);
      assert.strictEqual(created.currency, "EUR");
      assert.strictEqual(created.regionCode, "crete");
      assert.strictEqual(created.lat, 35.34);
      assert.strictEqual(created.lng, 25.13);
      assert.strictEqual(created.sizeSqm, 74);
      assert.strictEqual(created.availableFrom?.getTime(), AT + 86_400_000);
      assert.strictEqual(created.furnished, true);
      assert.strictEqual(created.ensuite, false);
      assert.strictEqual(created.smoking, false);
      assert.strictEqual(created.pets, true);
      assert.strictEqual(created.createdAt.getTime(), AT);
      assert.strictEqual(created.updatedAt.getTime(), AT);
      assert.isNull(created.publishedAt);

      const found = Option.getOrThrow(yield* repo.findById(created.id));
      assert.strictEqual(found.id, created.id);
      assert.strictEqual(found.title, created.title);

      const missing = yield* repo.findById(listingId(9_999_999));
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("listByOwner is owner scoped, newest first, and cursored", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-list", "listing-list@test.local");
      yield* insertUser("u-listing-list-other", "listing-list-other@test.local");
      yield* insertListing(4101, "u-listing-list", { createdAt: AT + 1_000 });
      yield* insertListing(4102, "u-listing-list", { createdAt: AT + 2_000 });
      yield* insertListing(4103, "u-listing-list", { createdAt: AT + 3_000 });
      yield* insertListing(4110, "u-listing-list-other", { createdAt: AT + 4_000 });

      const repo = yield* ListingRepository;

      const first = yield* repo.listByOwner(ownerId("u-listing-list"), page(2));
      assert.deepStrictEqual(
        first.items.map((item) => item.id),
        [4103, 4102],
      );
      assert.isNotNull(first.nextCursor);

      const second = yield* repo.listByOwner(ownerId("u-listing-list"), {
        limit: 2,
        cursor: cursorOf(first.nextCursor),
      });
      assert.deepStrictEqual(
        second.items.map((item) => item.id),
        [4101],
      );
      assert.isNull(second.nextCursor);

      const foreign = yield* repo.listByOwner(ownerId("u-listing-list"), page(50));
      assert.notInclude(
        foreign.items.map((item): number => item.id),
        4110,
      );
    }),
  );

  it.effect("search sees published listings only and filters every facet", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-search", "listing-search@test.local");
      yield* insertUser("u-listing-search-other", "listing-search-other@test.local");
      // Published fixtures, one per facet.
      yield* insertListing(4201, "u-listing-search", {
        status: "published",
        kind: "room",
        regionCode: "attica",
        priceMinor: 40_000,
        furnished: true,
        ensuite: true,
        smoking: false,
        pets: true,
        availableFrom: AT + 1_000,
        sizeSqm: 22,
        createdAt: AT + 1_000,
      });
      yield* insertListing(4202, "u-listing-search", {
        status: "published",
        kind: "whole_property",
        regionCode: "crete",
        priceMinor: 90_000,
        furnished: false,
        ensuite: false,
        smoking: true,
        pets: false,
        availableFrom: AT + 2_000,
        sizeSqm: 74,
        createdAt: AT + 2_000,
      });
      yield* insertListing(4203, "u-listing-search-other", {
        status: "published",
        kind: "room_wanted",
        regionCode: "attica",
        priceMinor: 65_000,
        furnished: false,
        ensuite: false,
        smoking: false,
        pets: false,
        availableFrom: null,
        createdAt: AT + 3_000,
      });
      // Never visible in public search.
      yield* insertListing(4210, "u-listing-search", { status: "draft", createdAt: AT + 4_000 });
      yield* insertListing(4211, "u-listing-search", {
        status: "unpublished",
        publishedAt: AT + 4_000,
        createdAt: AT + 5_000,
      });

      const repo = yield* ListingRepository;
      const ids = (result: {
        readonly items: ReadonlyArray<{ readonly id: number }>;
      }): Array<number> => result.items.map((item) => item.id);

      const all = yield* repo.search({}, page(50));
      assert.includeMembers(ids(all), [4201, 4202, 4203]);
      assert.notInclude(ids(all), 4210);
      assert.notInclude(ids(all), 4211);

      assert.deepStrictEqual(ids(yield* repo.search({ kind: "room" }, page(50))), [4201]);
      assert.deepStrictEqual(ids(yield* repo.search({ regionCode: "crete" }, page(50))), [4202]);
      assert.deepStrictEqual(
        ids(yield* repo.search({ regionCode: "attica" }, page(50))).sort(),
        [4201, 4203],
      );
      assert.deepStrictEqual(
        ids(yield* repo.search({ minPriceMinor: 65_000 }, page(50))).sort(),
        [4202, 4203],
      );
      assert.deepStrictEqual(
        ids(yield* repo.search({ maxPriceMinor: 65_000 }, page(50))).sort(),
        [4201, 4203],
      );
      assert.deepStrictEqual(
        ids(
          yield* repo.search(
            { minPriceMinor: 40_000, maxPriceMinor: 40_000, kind: "room" },
            page(50),
          ),
        ),
        [4201],
      );

      // A `false` bit is a real filter, not an absent one.
      assert.deepStrictEqual(
        ids(yield* repo.search({ pets: false }, page(50))).sort(),
        [4202, 4203],
      );
      assert.deepStrictEqual(ids(yield* repo.search({ pets: true }, page(50))), [4201]);
      assert.deepStrictEqual(ids(yield* repo.search({ ensuite: true }, page(50))), [4201]);
      assert.deepStrictEqual(ids(yield* repo.search({ smoking: true }, page(50))), [4202]);

      // Availability excludes rows with no date.
      assert.deepStrictEqual(
        ids(yield* repo.search({ availableFrom: new Date(AT + 2_000) }, page(50))),
        [4202],
      );

      // Size bounds are inclusive, and a row with no size cannot satisfy one.
      assert.deepStrictEqual(ids(yield* repo.search({ minSizeSqm: 30 }, page(50))), [4202]);
      assert.deepStrictEqual(ids(yield* repo.search({ maxSizeSqm: 30 }, page(50))), [4201]);
      assert.deepStrictEqual(
        ids(yield* repo.search({ minSizeSqm: 22, maxSizeSqm: 74 }, page(50))).sort(),
        [4201, 4202],
      );
    }),
  );

  it.effect("search paging is stable when timestamps are identical", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-cursor", "listing-cursor@test.local");
      // Three published rows share one millisecond: only `id DESC` can order
      // them. They live in one region no other test uses so the page is exactly
      // these three rows.
      yield* insertListing(4301, "u-listing-cursor", {
        status: "published",
        regionCode: "epirus",
        createdAt: AT,
      });
      yield* insertListing(4302, "u-listing-cursor", {
        status: "published",
        regionCode: "epirus",
        createdAt: AT,
      });
      yield* insertListing(4303, "u-listing-cursor", {
        status: "published",
        regionCode: "epirus",
        createdAt: AT,
      });

      const repo = yield* ListingRepository;
      const first = yield* repo.search({ regionCode: "epirus" }, page(2));
      assert.deepStrictEqual(
        first.items.map((item) => item.id),
        [4303, 4302],
      );
      assert.isNotNull(first.nextCursor);

      const second = yield* repo.search(
        { regionCode: "epirus" },
        { limit: 2, cursor: cursorOf(first.nextCursor) },
      );
      assert.deepStrictEqual(
        second.items.map((item) => item.id),
        [4301],
      );
      assert.isNull(second.nextCursor);

      // No duplicates and no holes across the two pages.
      const seen = [...first.items, ...second.items].map((item) => item.id);
      assert.deepStrictEqual(seen, [4303, 4302, 4301]);
      assert.strictEqual(new Set(seen).size, seen.length);
    }),
  );

  it.effect("update is owner scoped and can clear a nullable field", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-update", "listing-update@test.local");
      yield* insertUser("u-listing-update-other", "listing-update-other@test.local");
      yield* insertListing(4401, "u-listing-update", {
        title: "Before",
        description: "before description",
        sizeSqm: 20,
        createdAt: AT,
      });

      const repo = yield* ListingRepository;
      const input: typeof UpdateListingInput.Type = {
        title: "After",
        description: null,
        priceMinor: 61_000,
        pets: true,
      };

      const denied = yield* repo.update(listingId(4401), ownerId("u-listing-update-other"), input);
      assert.isTrue(Option.isNone(denied));
      const untouched = Option.getOrThrow(yield* repo.findById(listingId(4401)));
      assert.strictEqual(untouched.title, "Before");
      assert.strictEqual(untouched.description, "before description");

      yield* TestClock.setTime(AT + 10_000);
      const updated = Option.getOrThrow(
        yield* repo.update(listingId(4401), ownerId("u-listing-update"), input),
      );
      assert.strictEqual(updated.title, "After");
      assert.isNull(updated.description);
      assert.strictEqual(updated.priceMinor, 61_000);
      assert.strictEqual(updated.pets, true);
      // Absent fields keep their stored value.
      assert.strictEqual(updated.sizeSqm, 20);
      assert.strictEqual(updated.regionCode, "attica");
      assert.strictEqual(updated.updatedAt.getTime(), AT + 10_000);
      assert.strictEqual(updated.createdAt.getTime(), AT);
    }),
  );

  it.effect("setStatus is a compare-and-set and is owner scoped", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-status", "listing-status@test.local");
      yield* insertUser("u-listing-status-other", "listing-status-other@test.local");
      yield* insertListing(4501, "u-listing-status", { createdAt: AT });

      const repo = yield* ListingRepository;
      yield* TestClock.setTime(AT + 1_000);

      const denied = yield* repo.setStatus(
        listingId(4501),
        ownerId("u-listing-status-other"),
        ["draft"],
        "published",
      );
      assert.isTrue(Option.isNone(denied));

      const published = Option.getOrThrow(
        yield* repo.setStatus(listingId(4501), ownerId("u-listing-status"), ["draft"], "published"),
      );
      assert.strictEqual(published.status, "published");
      assert.strictEqual(published.publishedAt?.getTime(), AT + 1_000);

      // The same transition again is stale: the row is no longer a draft.
      const repeated = yield* repo.setStatus(
        listingId(4501),
        ownerId("u-listing-status"),
        ["draft"],
        "published",
      );
      assert.isTrue(Option.isNone(repeated));

      const unlisted = Option.getOrThrow(
        yield* repo.setStatus(
          listingId(4501),
          ownerId("u-listing-status"),
          ["published"],
          "unpublished",
        ),
      );
      assert.strictEqual(unlisted.status, "unpublished");
      // Unlisting preserves `published_at`.
      assert.strictEqual(unlisted.publishedAt?.getTime(), AT + 1_000);
    }),
  );

  it.effect("the database rejects rows the schema forbids", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-check", "listing-check@test.local");
      const sql = yield* SqlClient.SqlClient;

      const rejects = (statement: Effect.Effect<unknown, unknown>) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(statement);
          assert.strictEqual((error as { readonly _tag?: string })._tag, "SqlError");
        });

      const insert = (values: {
        readonly id: number;
        readonly kind?: string;
        readonly status?: string;
        readonly regionCode?: string;
        readonly lat?: number | null;
        readonly lng?: number | null;
        readonly publishedAt?: number | null;
      }) =>
        sql.unsafe(
          `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code, lat, lng, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            values.id,
            values.kind ?? "room",
            "u-listing-check",
            values.status ?? "draft",
            "Constraint probe",
            1_000,
            values.regionCode ?? "attica",
            values.lat ?? null,
            values.lng ?? null,
            values.publishedAt ?? null,
          ],
        );

      yield* rejects(insert({ id: 4601, status: "published" })); // published without published_at
      yield* rejects(insert({ id: 4602, lat: 37.98 })); // lat without lng
      yield* rejects(insert({ id: 4603, regionCode: "atlantis" })); // unknown region FK
      yield* rejects(insert({ id: 4604, kind: "castle" })); // unknown kind

      // All three kinds are accepted.
      for (const [index, kind] of ["room", "whole_property", "room_wanted"].entries()) {
        yield* insert({ id: 4610 + index, kind });
      }
    }),
  );

  it.effect("every TypeScript region literal is accepted by the region foreign key", () =>
    Effect.gen(function* () {
      yield* insertUser("u-listing-regions", "listing-regions@test.local");
      const sql = yield* SqlClient.SqlClient;

      // Pinning test: the migration seed and `GreekRegionCodes` must not drift.
      for (const [index, code] of GreekRegionCodes.entries()) {
        yield* insertListing(4700 + index, "u-listing-regions", { regionCode: code });
      }

      const seeded = yield* sql<{ readonly code: string }>`SELECT code FROM regions ORDER BY code`;
      assert.deepStrictEqual(
        seeded.map((row) => row.code),
        [...GreekRegionCodes].sort(),
      );

      const rejected = yield* Effect.flip(
        sql.unsafe(
          `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [4799, "room", "u-listing-regions", "draft", "Unknown region", 1_000, "not_a_region"],
        ),
      );
      assert.strictEqual((rejected as { readonly _tag?: string })._tag, "SqlError");
    }),
  );
});
