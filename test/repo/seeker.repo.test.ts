import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { UserId } from "@/db/schema/brands"
import { SeekerRepository, SeekerRepositoryLive } from "@/repo/seeker.repo"
import { TestSqlLive } from "../support/sql"
import { insertSeeker, insertUser } from "../support/seed"

const userId = (value: string) => Schema.decodeSync(UserId)(value)

const TestLive = Layer.merge(
  SeekerRepositoryLive.pipe(Layer.provide(TestSqlLive)),
  TestSqlLive,
)

layer(TestLive, { concurrent: false })("SeekerRepository", (it) => {
  it.effect("findByUserId decodes a seeker profile", () =>
    Effect.gen(function*() {
      yield* insertUser("u-seeker-profile", "seeker-profile@test.local", "seeker")
      yield* insertSeeker("u-seeker-profile", {
        name: "Lin Seeker",
        bio: "Looking for a quiet room",
        dateOfBirth: new Date("1995-04-12T00:00:00.000Z").getTime(),
        gender: "female",
        picture: "https://cdn.test.local/lin.png",
        smoking: true,
        pets: false,
      })

      const repo = yield* SeekerRepository
      const found = yield* repo.findByUserId(userId("u-seeker-profile"))
      assert.isTrue(Option.isSome(found))
      const seeker = Option.getOrThrow(found)
      assert.strictEqual(seeker.userId, "u-seeker-profile")
      assert.strictEqual(seeker.name, "Lin Seeker")
      assert.strictEqual(seeker.bio, "Looking for a quiet room")
      assert.strictEqual(seeker.gender, "female")
      assert.strictEqual(seeker.smoking, true)
      assert.strictEqual(seeker.pets, false)
      assert.instanceOf(seeker.dateOfBirth, Date)
      assert.strictEqual(seeker.dateOfBirth.getTime(), new Date("1995-04-12T00:00:00.000Z").getTime())
      assert.instanceOf(seeker.createdAt, Date)
    }))

  it.effect("findByUserId returns None for an unknown user", () =>
    Effect.gen(function*() {
      const repo = yield* SeekerRepository
      const missing = yield* repo.findByUserId(userId("u-seeker-missing"))
      assert.isTrue(Option.isNone(missing))
    }))
})
