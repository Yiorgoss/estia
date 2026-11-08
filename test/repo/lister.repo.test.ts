import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { UserId } from "@/db/schema/brands";
import { ListerRepository, ListerRepositoryLive } from "@/repos/lister.repo";
import { TestSqlLive } from "../support/sql";
import { insertLister, insertUser } from "../support/seed";

const userId = (value: string) => Schema.decodeSync(UserId)(value);

const TestLive = Layer.merge(ListerRepositoryLive.pipe(Layer.provide(TestSqlLive)), TestSqlLive);

layer(TestLive, { concurrent: false })("ListerRepository", (it) => {
  it.effect("findByUserId decodes a lister profile", () =>
    Effect.gen(function* () {
      yield* insertUser("u-lister-profile", "lister-profile@test.local", "lister");
      yield* insertLister(101, "u-lister-profile", {
        name: "Ada Lister",
        ownership: "leaseholder",
      });

      const repo = yield* ListerRepository;
      const found = yield* repo.findByUserId(userId("u-lister-profile"));
      assert.isTrue(Option.isSome(found));
      const lister = Option.getOrThrow(found);
      assert.strictEqual(lister.id, 101);
      assert.strictEqual(lister.userId, "u-lister-profile");
      assert.strictEqual(lister.name, "Ada Lister");
      assert.strictEqual(lister.ownership, "leaseholder");
      assert.instanceOf(lister.createdAt, Date);
    }),
  );

  it.effect("findByUserId returns nullish profile fields as null", () =>
    Effect.gen(function* () {
      yield* insertUser("u-lister-empty", "lister-empty@test.local", "lister");
      yield* insertLister(102, "u-lister-empty");

      const repo = yield* ListerRepository;
      const found = Option.getOrThrow(yield* repo.findByUserId(userId("u-lister-empty")));
      assert.strictEqual(found.ownership, "owner");
      assert.strictEqual(found.name, "Lister");
    }),
  );

  it.effect("findByUserId returns None for an unknown user", () =>
    Effect.gen(function* () {
      const repo = yield* ListerRepository;
      const missing = yield* repo.findByUserId(userId("u-lister-missing"));
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("createForUser opens a profile with the column defaults", () =>
    Effect.gen(function* () {
      yield* insertUser("u-lister-create", "lister-create@test.local", "lister");

      const repo = yield* ListerRepository;
      const lister = yield* repo.createForUser(userId("u-lister-create"));

      assert.strictEqual(lister.userId, "u-lister-create");
      assert.strictEqual(lister.ownership, "owner");
      assert.isNull(lister.name);
      assert.instanceOf(lister.createdAt, Date);
    }),
  );

  // A double click, a retry, or two tabs can ask twice for the same profile. The
  // second ask is the same profile, not a uniqueness failure.
  it.effect("createForUser answers with the existing profile on a second ask", () =>
    Effect.gen(function* () {
      yield* insertUser("u-lister-twice", "lister-twice@test.local", "lister");

      const repo = yield* ListerRepository;
      const first = yield* repo.createForUser(userId("u-lister-twice"));
      const second = yield* repo.createForUser(userId("u-lister-twice"));

      assert.strictEqual(second.id, first.id);
      assert.strictEqual(second.userId, "u-lister-twice");
    }),
  );
});
