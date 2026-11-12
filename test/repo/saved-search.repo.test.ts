import { SavedSearchId, UserId } from "@/db/schema/brands";
import { SavedSearchRepository, SavedSearchRepositoryLive } from "@/repos/saved-search.repo";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { insertUser } from "../support/seed";
import { TestSqlLive } from "../support/sql";

const userId = (value: string) => Schema.decodeSync(UserId)(value);
const savedSearchId = (value: number) => Schema.decodeSync(SavedSearchId)(value);

const TestLive = Layer.merge(
  SavedSearchRepositoryLive.pipe(Layer.provide(TestSqlLive)),
  TestSqlLive,
);

// `Clock.currentTimeMillis` reads 0 under `it.effect`; tests that care about a
// stored timestamp set the clock explicitly.
const AT = 1_700_000_000_000;

layer(TestLive, { concurrent: false })("SavedSearchRepository", (it) => {
  it.effect("create stores the criteria and decodes the row", () =>
    Effect.gen(function* () {
      yield* insertUser("u-saved-create", "saved-create@test.local");
      yield* TestClock.setTime(AT);

      const repo = yield* SavedSearchRepository;
      const created = yield* repo.create(userId("u-saved-create"), {
        name: "Balcony rooms in Attica",
        kind: "room",
        regionCode: "attica",
        minPriceMinor: 40_000,
        maxPriceMinor: 80_000,
        minSizeSqm: 20,
        maxSizeSqm: 50,
        furnished: true,
        pets: false,
        availableFrom: new Date(AT + 86_400_000),
      });

      assert.isNumber(created.id);
      assert.strictEqual(created.userId, "u-saved-create");
      assert.strictEqual(created.name, "Balcony rooms in Attica");
      assert.strictEqual(created.kind, "room");
      assert.strictEqual(created.regionCode, "attica");
      assert.strictEqual(created.minPriceMinor, 40_000);
      assert.strictEqual(created.maxPriceMinor, 80_000);
      assert.strictEqual(created.minSizeSqm, 20);
      assert.strictEqual(created.maxSizeSqm, 50);
      assert.strictEqual(created.furnished, true);
      assert.isNull(created.ensuite);
      assert.isNull(created.smoking);
      assert.strictEqual(created.pets, false);
      assert.strictEqual(created.availableFrom?.getTime(), AT + 86_400_000);
      assert.strictEqual(created.createdAt.getTime(), AT);
    }),
  );

  it.effect("create stores a criteria-less search with every filter null", () =>
    Effect.gen(function* () {
      yield* insertUser("u-saved-empty", "saved-empty@test.local");

      const repo = yield* SavedSearchRepository;
      const created = yield* repo.create(userId("u-saved-empty"), { name: "All listings" });

      assert.strictEqual(created.name, "All listings");
      for (const value of [
        created.kind,
        created.regionCode,
        created.minPriceMinor,
        created.maxPriceMinor,
        created.minSizeSqm,
        created.maxSizeSqm,
        created.furnished,
        created.ensuite,
        created.smoking,
        created.pets,
        created.availableFrom,
      ]) {
        assert.isNull(value);
      }
    }),
  );

  it.effect("listByUser is owner scoped and newest first", () =>
    Effect.gen(function* () {
      yield* insertUser("u-saved-list", "saved-list@test.local");
      yield* insertUser("u-saved-list-other", "saved-list-other@test.local");

      const repo = yield* SavedSearchRepository;
      yield* TestClock.setTime(AT);
      const first = yield* repo.create(userId("u-saved-list"), { name: "First" });
      yield* TestClock.setTime(AT + 1_000);
      const second = yield* repo.create(userId("u-saved-list"), { name: "Second" });
      yield* repo.create(userId("u-saved-list-other"), { name: "Someone else's" });

      const mine = yield* repo.listByUser(userId("u-saved-list"));
      assert.deepStrictEqual(
        mine.map((row) => row.name),
        ["Second", "First"],
      );
      assert.deepStrictEqual(
        mine.map((row) => row.id),
        [second.id, first.id],
      );

      const theirs = yield* repo.listByUser(userId("u-saved-list-other"));
      assert.deepStrictEqual(
        theirs.map((row) => row.name),
        ["Someone else's"],
      );
    }),
  );

  it.effect("findByIdForUser only answers for the owner", () =>
    Effect.gen(function* () {
      yield* insertUser("u-saved-find", "saved-find@test.local");
      yield* insertUser("u-saved-find-other", "saved-find-other@test.local");

      const repo = yield* SavedSearchRepository;
      const created = yield* repo.create(userId("u-saved-find"), {
        name: "Mine",
        regionCode: "crete",
      });

      const mine = yield* repo.findByIdForUser(userId("u-saved-find"), created.id);
      assert.isTrue(Option.isSome(mine));
      assert.strictEqual(Option.getOrThrow(mine).name, "Mine");

      assert.isTrue(
        Option.isNone(yield* repo.findByIdForUser(userId("u-saved-find-other"), created.id)),
      );
      assert.isTrue(
        Option.isNone(yield* repo.findByIdForUser(userId("u-saved-find"), savedSearchId(999_999))),
      );
    }),
  );

  it.effect("deleteForUser removes only the owner's row", () =>
    Effect.gen(function* () {
      yield* insertUser("u-saved-delete", "saved-delete@test.local");
      yield* insertUser("u-saved-delete-other", "saved-delete-other@test.local");

      const repo = yield* SavedSearchRepository;
      const mine = yield* repo.create(userId("u-saved-delete"), { name: "Mine" });
      const theirs = yield* repo.create(userId("u-saved-delete-other"), { name: "Theirs" });

      // Another account's delete matches no row and leaves the row in place.
      assert.isTrue(
        Option.isNone(yield* repo.deleteForUser(userId("u-saved-delete-other"), mine.id)),
      );
      assert.isTrue(
        Option.isSome(yield* repo.findByIdForUser(userId("u-saved-delete"), mine.id)),
      );

      const deleted = yield* repo.deleteForUser(userId("u-saved-delete"), mine.id);
      assert.isTrue(Option.isSome(deleted));
      assert.strictEqual(Option.getOrThrow(deleted).id, mine.id);
      assert.isTrue(
        Option.isNone(yield* repo.findByIdForUser(userId("u-saved-delete"), mine.id)),
      );

      // The other account's row is untouched, and a second delete has nothing left.
      assert.isTrue(
        Option.isSome(yield* repo.findByIdForUser(userId("u-saved-delete-other"), theirs.id)),
      );
      assert.isTrue(
        Option.isNone(yield* repo.deleteForUser(userId("u-saved-delete"), mine.id)),
      );
    }),
  );
});
