import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { UserId, UserPasswordHash } from "@/db/schema/brands"
import { UserRepository, UserRepositoryLive } from "@/repo/user.repo"
import { TestSqlLive } from "../support/sql"

const password = (value: string) => Schema.decodeSync(UserPasswordHash)(value)
const userId = (value: string) => Schema.decodeSync(UserId)(value)

const TestLive = Layer.merge(
  UserRepositoryLive.pipe(Layer.provide(TestSqlLive)),
  TestSqlLive,
)

layer(TestLive, { concurrent: false })("UserRepository", (it) => {
  it.effect("insert persists a row and returns the decoded user", () =>
    Effect.gen(function*() {
      const repo = yield* UserRepository
      const inserted = yield* repo.insert({
        email: "insert@test.local",
        password: password("hash-insert"),
      })
      assert.isTrue(Option.isSome(inserted))
      const user = Option.getOrThrow(inserted)
      assert.strictEqual(user.email, "insert@test.local")
      assert.strictEqual(user.passwordHash, password("hash-insert"))
      assert.strictEqual(user.role, "user")
      assert.isTrue(user.id.length > 0)
      // `user.repo.ts` maps raw rows without decoding through `UserSchema`, so
      // the timestamp columns arrive as epoch millis even though the type is
      // `Date`.
      assert.strictEqual(typeof user.createdAt, "number")
      assert.strictEqual(typeof user.updatedAt, "number")

      // The repository and the raw client share one in-memory database.
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql.unsafe<{ email: string }>("SELECT email FROM users")
      assert.deepStrictEqual(rows.map((row) => row.email), ["insert@test.local"])
    }))

  it.effect("findByEmail returns Some for a known address and None otherwise", () =>
    Effect.gen(function*() {
      const repo = yield* UserRepository
      yield* repo.insert({
        email: "lookup@test.local",
        password: password("hash-lookup"),
      })

      const found = yield* repo.findByEmail("lookup@test.local")
      assert.isTrue(Option.isSome(found))
      assert.strictEqual(Option.getOrThrow(found).email, "lookup@test.local")

      const missing = yield* repo.findByEmail("missing@test.local")
      assert.isTrue(Option.isNone(missing))
    }))

  it.effect("findById returns Some for a known id and None otherwise", () =>
    Effect.gen(function*() {
      const repo = yield* UserRepository
      const inserted = Option.getOrThrow(
        yield* repo.insert({
          email: "by-id@test.local",
          password: password("hash-by-id"),
        }),
      )

      const found = yield* repo.findById(inserted.id)
      assert.isTrue(Option.isSome(found))
      assert.strictEqual(Option.getOrThrow(found).id, inserted.id)

      const missing = yield* repo.findById(userId("00000000000000000000000000000000"))
      assert.isTrue(Option.isNone(missing))
    }))

  it.effect("updateRole changes the role and persists it", () =>
    Effect.gen(function*() {
      const repo = yield* UserRepository
      const inserted = Option.getOrThrow(
        yield* repo.insert({
          email: "role@test.local",
          password: password("hash-role"),
        }),
      )

      const updated = yield* repo.updateRole(inserted.id, "admin")
      assert.isTrue(Option.isSome(updated))
      assert.strictEqual(Option.getOrThrow(updated).role, "admin")

      const reread = Option.getOrThrow(yield* repo.findById(inserted.id))
      assert.strictEqual(reread.role, "admin")

      const missing = yield* repo.updateRole(userId("00000000000000000000000000000000"), "admin")
      assert.isTrue(Option.isNone(missing))
    }))

  it.effect("insert fails with a SqlError when the email is already taken", () =>
    Effect.gen(function*() {
      const repo = yield* UserRepository
      yield* repo.insert({
        email: "duplicate@test.local",
        password: password("hash-first"),
      })

      const error = yield* Effect.flip(
        repo.insert({
          email: "duplicate@test.local",
          password: password("hash-second"),
        }),
      )
      assert.strictEqual(error._tag, "SqlError")
    }))
})
