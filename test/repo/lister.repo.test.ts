import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { UserId } from "@/db/schema/brands"
import { ListerRepository, ListerRepositoryLive } from "@/repo/lister.repo"
import { TestSqlLive } from "../support/sql"
import { insertLister, insertUser } from "../support/seed"

const userId = (value: string) => Schema.decodeSync(UserId)(value)

const TestLive = Layer.merge(
  ListerRepositoryLive.pipe(Layer.provide(TestSqlLive)),
  TestSqlLive,
)

layer(TestLive, { concurrent: false })("ListerRepository", (it) => {
  it.effect("findByUserId decodes a lister profile", () =>
    Effect.gen(function*() {
      yield* insertUser("u-lister-profile", "lister-profile@test.local", "lister")
      yield* insertLister(101, "u-lister-profile", {
        name: "Ada Lister",
        ownership: "leaseholder",
        picture: "https://cdn.test.local/ada.png",
      })

      const repo = yield* ListerRepository
      const found = yield* repo.findByUserId(userId("u-lister-profile"))
      assert.isTrue(Option.isSome(found))
      const lister = Option.getOrThrow(found)
      assert.strictEqual(lister.id, 101)
      assert.strictEqual(lister.userId, "u-lister-profile")
      assert.strictEqual(lister.name, "Ada Lister")
      assert.strictEqual(lister.ownership, "leaseholder")
      assert.strictEqual(lister.picture, "https://cdn.test.local/ada.png")
      assert.instanceOf(lister.createdAt, Date)
    }))

  it.effect("findByUserId returns nullish profile fields as null", () =>
    Effect.gen(function*() {
      yield* insertUser("u-lister-empty", "lister-empty@test.local", "lister")
      yield* insertLister(102, "u-lister-empty")

      const repo = yield* ListerRepository
      const found = Option.getOrThrow(yield* repo.findByUserId(userId("u-lister-empty")))
      assert.strictEqual(found.ownership, "owner")
      assert.isNull(found.picture)
      assert.strictEqual(found.name, "Lister")
    }))

  it.effect("findByUserId returns None for an unknown user", () =>
    Effect.gen(function*() {
      const repo = yield* ListerRepository
      const missing = yield* repo.findByUserId(userId("u-lister-missing"))
      assert.isTrue(Option.isNone(missing))
    }))
})
