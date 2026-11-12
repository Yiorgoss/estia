import { SavedSearchId, UserId } from "@/db/schema/brands";
import { SavedSearchRepositoryLive } from "@/repos/saved-search.repo";
import {
  SavedSearchService,
  SavedSearchServiceLive,
  summarizeSavedSearch,
} from "@/services/saved-search.service";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { insertUser } from "../support/seed";
import { TestSqlLive } from "../support/sql";

const ownerId = (value: string) => Schema.decodeSync(UserId)(value);
const savedSearchId = (value: number) => Schema.decodeSync(SavedSearchId)(value);

const RepositoriesLive = SavedSearchRepositoryLive.pipe(Layer.provide(TestSqlLive));
const TestLive = Layer.merge(
  SavedSearchServiceLive.pipe(Layer.provide(RepositoriesLive)),
  TestSqlLive,
);

const tagOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (error as { readonly _tag?: string })._tag),
    Effect.orElseSucceed(() => "success"),
  );

layer(TestLive, { concurrent: false })("SavedSearchService", (it) => {
  it.effect("create stores an explicit name with the criteria", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-saved-named", "svc-saved-named@test.local");
      const service = yield* SavedSearchService;

      const created = yield* service.create(ownerId("u-svc-saved-named"), {
        name: "Crete rooms",
        regionCode: "crete",
        kind: "room",
        maxPriceMinor: 90_000,
        pets: true,
      });

      assert.strictEqual(created.name, "Crete rooms");
      assert.strictEqual(created.userId, "u-svc-saved-named");
      assert.strictEqual(created.regionCode, "crete");
      assert.strictEqual(created.kind, "room");
      assert.strictEqual(created.maxPriceMinor, 90_000);
      assert.strictEqual(created.pets, true);
    }),
  );

  it.effect("create names an unnamed search after its criteria", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-saved-default", "svc-saved-default@test.local");
      const service = yield* SavedSearchService;

      const created = yield* service.create(ownerId("u-svc-saved-default"), {
        kind: "room",
        regionCode: "attica",
        minPriceMinor: 40_000,
        maxPriceMinor: 80_000,
        minSizeSqm: 20,
        maxSizeSqm: 50,
        furnished: true,
        pets: false,
        availableFrom: new Date("2026-03-01T00:00:00.000Z"),
      });

      assert.strictEqual(
        created.name,
        "Room in Attica €400-€800/mo 20-50 m² Furnished, No pets available from 1 Mar 2026",
      );
    }),
  );

  it.effect("create without any criteria names the search All listings", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-saved-empty", "svc-saved-empty@test.local");
      const service = yield* SavedSearchService;

      const created = yield* service.create(ownerId("u-svc-saved-empty"), {});
      assert.strictEqual(created.name, "All listings");
    }),
  );

  it.effect("list returns only the caller's saved searches", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-saved-list", "svc-saved-list@test.local");
      yield* insertUser("u-svc-saved-list-other", "svc-saved-list-other@test.local");
      const service = yield* SavedSearchService;

      yield* service.create(ownerId("u-svc-saved-list"), { name: "Mine" });
      yield* service.create(ownerId("u-svc-saved-list-other"), { name: "Theirs" });

      const mine = yield* service.list(ownerId("u-svc-saved-list"));
      assert.deepStrictEqual(
        mine.map((row) => row.name),
        ["Mine"],
      );
    }),
  );

  it.effect("findOwned never answers with another account's row", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-saved-find", "svc-saved-find@test.local");
      yield* insertUser("u-svc-saved-find-other", "svc-saved-find-other@test.local");
      const service = yield* SavedSearchService;

      const created = yield* service.create(ownerId("u-svc-saved-find"), { name: "Mine" });

      const mine = yield* service.findOwned(ownerId("u-svc-saved-find"), created.id);
      assert.isTrue(Option.isSome(mine));
      assert.isTrue(
        Option.isNone(yield* service.findOwned(ownerId("u-svc-saved-find-other"), created.id)),
      );
    }),
  );

  it.effect("delete removes the caller's row and refuses another account's", () =>
    Effect.gen(function* () {
      yield* insertUser("u-svc-saved-delete", "svc-saved-delete@test.local");
      yield* insertUser("u-svc-saved-delete-other", "svc-saved-delete-other@test.local");
      const service = yield* SavedSearchService;

      const mine = yield* service.create(ownerId("u-svc-saved-delete"), { name: "Mine" });
      const theirs = yield* service.create(ownerId("u-svc-saved-delete-other"), {
        name: "Theirs",
      });

      assert.strictEqual(
        yield* tagOf(service.delete(ownerId("u-svc-saved-delete-other"), mine.id)),
        "SavedSearchNotFoundError",
      );
      assert.isTrue(Option.isSome(yield* service.findOwned(ownerId("u-svc-saved-delete"), mine.id)));

      // An unknown id is the same refusal as another account's id.
      assert.strictEqual(
        yield* tagOf(service.delete(ownerId("u-svc-saved-delete"), savedSearchId(999_999))),
        "SavedSearchNotFoundError",
      );

      yield* service.delete(ownerId("u-svc-saved-delete"), mine.id);
      assert.isTrue(
        Option.isNone(yield* service.findOwned(ownerId("u-svc-saved-delete"), mine.id)),
      );
      assert.isTrue(
        Option.isSome(yield* service.findOwned(ownerId("u-svc-saved-delete-other"), theirs.id)),
      );
      assert.strictEqual(
        yield* tagOf(service.delete(ownerId("u-svc-saved-delete"), mine.id)),
        "SavedSearchNotFoundError",
      );
    }),
  );

  it("summarizeSavedSearch keeps a long summary inside the name bound", () => {
    const summary = summarizeSavedSearch({
      kind: "whole_property",
      regionCode: "eastern_macedonia_and_thrace",
      minPriceMinor: Number.MAX_SAFE_INTEGER,
      maxPriceMinor: Number.MAX_SAFE_INTEGER,
      minSizeSqm: Number.MAX_SAFE_INTEGER,
      maxSizeSqm: Number.MAX_SAFE_INTEGER,
      furnished: true,
      pets: true,
    });
    assert.isAtMost(summary.length, 120);
    assert.isTrue(summary.endsWith("..."));
  });
});
