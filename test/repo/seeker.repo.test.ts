import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { UserId } from "@/db/schema/brands";
import { SeekerRepository, SeekerRepositoryLive } from "@/repos/seeker.repo";
import { TestSqlLive } from "../support/sql";
import { insertSeeker, insertUser } from "../support/seed";

const userId = (value: string) => Schema.decodeSync(UserId)(value);

const TestLive = Layer.merge(SeekerRepositoryLive.pipe(Layer.provide(TestSqlLive)), TestSqlLive);

layer(TestLive, { concurrent: false })("SeekerRepository", (it) => {
  it.effect("findByUserId decodes a seeker profile", () =>
    Effect.gen(function* () {
      yield* insertUser("u-seeker-profile", "seeker-profile@test.local", "seeker");
      yield* insertSeeker("u-seeker-profile", {
        name: "Lin Seeker",
        bio: "Looking for a quiet room",
        dateOfBirth: new Date("1995-04-12T00:00:00.000Z").getTime(),
        gender: "female",
        smoking: true,
        pets: false,
      });

      const repo = yield* SeekerRepository;
      const found = yield* repo.findByUserId(userId("u-seeker-profile"));
      assert.isTrue(Option.isSome(found));
      const seeker = Option.getOrThrow(found);
      assert.strictEqual(seeker.userId, "u-seeker-profile");
      assert.strictEqual(seeker.name, "Lin Seeker");
      assert.strictEqual(seeker.bio, "Looking for a quiet room");
      assert.strictEqual(seeker.gender, "female");
      assert.strictEqual(seeker.smoking, true);
      assert.strictEqual(seeker.pets, false);
      assert.instanceOf(seeker.dateOfBirth, Date);
      assert.strictEqual(
        seeker.dateOfBirth.getTime(),
        new Date("1995-04-12T00:00:00.000Z").getTime(),
      );
      assert.instanceOf(seeker.createdAt, Date);
    }),
  );

  it.effect("createForUser opens a profile nobody has filled in yet", () =>
    Effect.gen(function* () {
      yield* insertUser("u-seeker-create", "seeker-create@test.local", "seeker");

      const repo = yield* SeekerRepository;
      const seeker = yield* repo.createForUser(userId("u-seeker-create"));

      assert.strictEqual(seeker.userId, "u-seeker-create");
      // Migration 0006 made the fields a person fills in themselves optional, so
      // the profile exists before anyone has typed a name.
      assert.isNull(seeker.name);
      assert.isNull(seeker.dateOfBirth);
      assert.isNull(seeker.gender);
      assert.strictEqual(seeker.smoking, false);
      assert.strictEqual(seeker.pets, false);
      assert.instanceOf(seeker.createdAt, Date);
    }),
  );

  // A double click, a retry, or the heal of a legacy account asks again for the
  // same profile. The second ask is the same row, not a uniqueness failure.
  it.effect("createForUser answers with the existing profile on a second ask", () =>
    Effect.gen(function* () {
      yield* insertUser("u-seeker-twice", "seeker-twice@test.local", "seeker");

      const repo = yield* SeekerRepository;
      const first = yield* repo.createForUser(userId("u-seeker-twice"));
      const second = yield* repo.createForUser(userId("u-seeker-twice"));

      assert.strictEqual(second.id, first.id);
      assert.strictEqual(second.userId, "u-seeker-twice");
    }),
  );

  it.effect("findByUserId returns None for an unknown user", () =>
    Effect.gen(function* () {
      const repo = yield* SeekerRepository;
      const missing = yield* repo.findByUserId(userId("u-seeker-missing"));
      assert.isTrue(Option.isNone(missing));
    }),
  );

  // The save path writes a profile that already exists, and opens one that does
  // not, so a legacy account is repaired rather than refused.
  it.effect("upsertForUser writes an existing profile and opens a missing one", () =>
    Effect.gen(function* () {
      yield* insertUser("u-seeker-upsert", "seeker-upsert@test.local", "seeker");
      const repo = yield* SeekerRepository;
      const dateOfBirth = new Date("1995-04-12T00:00:00.000Z");

      const opened = yield* repo.upsertForUser(userId("u-seeker-upsert"), {
        name: "Ada Seeker",
        dateOfBirth,
        gender: "female",
        bio: "Looking for a quiet room",
        smoking: true,
        pets: false,
      });
      assert.strictEqual(opened.userId, "u-seeker-upsert");
      assert.strictEqual(opened.name, "Ada Seeker");
      assert.strictEqual(opened.bio, "Looking for a quiet room");
      assert.strictEqual(opened.gender, "female");
      assert.strictEqual(opened.smoking, true);
      assert.strictEqual(opened.pets, false);
      assert.strictEqual(opened.dateOfBirth?.getTime(), dateOfBirth.getTime());

      // A save replaces the whole profile: an absent bio is written as null.
      const rewritten = yield* repo.upsertForUser(userId("u-seeker-upsert"), {
        name: "Ada Lovelace",
        dateOfBirth,
        gender: "NB",
      });
      assert.strictEqual(rewritten.id, opened.id);
      assert.strictEqual(rewritten.name, "Ada Lovelace");
      assert.isNull(rewritten.bio);
      assert.strictEqual(rewritten.gender, "NB");
      assert.strictEqual(rewritten.smoking, false);
    }),
  );
});
