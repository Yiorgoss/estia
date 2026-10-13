import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { RefreshTokenHash, UserId } from "@/db/schema/brands"
import { RefreshTokenRepository, RefreshTokenRepositoryLive } from "@/repo/refresh-token.repo"
import { TestSqlLive } from "../support/sql"
import { insertRefreshToken, insertUser } from "../support/seed"

const userId = (value: string) => Schema.decodeSync(UserId)(value)
const tokenHash = (value: string) => Schema.decodeSync(RefreshTokenHash)(value)

// `findValidByUserID` is declared with `id: number`, but `refresh_tokens.user_id`
// is TEXT and real user ids are strings. Pass a real string id, as production
// does, without changing production code.
const userKey = (value: string) => value as unknown as number

// `revoke`, `findValidByHash` and `findValidByUserID` compare against the
// Effect clock. `it.effect` starts that clock at 0, so a positive `expiresAt`
// is valid and a negative one is already expired.
const VALID_EXPIRES_AT = 3_600_000

const TestLive = Layer.merge(
  RefreshTokenRepositoryLive.pipe(Layer.provide(TestSqlLive)),
  TestSqlLive,
)

layer(TestLive, { concurrent: false })("RefreshTokenRepository", (it) => {
  it.effect("new inserts a token and returns the decoded row", () =>
    Effect.gen(function*() {
      yield* insertUser("u-rt-new", "rt-new@test.local")

      const repo = yield* RefreshTokenRepository
      const created = yield* repo.new({
        userId: userId("u-rt-new"),
        tokenHash: tokenHash("hash-new"),
        expiresAt: VALID_EXPIRES_AT,
        deviceInfo: "Pixel 9",
      })
      assert.strictEqual(created.userId, "u-rt-new")
      assert.strictEqual(created.tokenHash, "hash-new")
      assert.strictEqual(created.deviceInfo, "Pixel 9")
      assert.strictEqual(created.expiresAt, VALID_EXPIRES_AT)
      assert.isNull(created.revokedAt)
      assert.strictEqual(typeof created.createdAt, "number")
      assert.isTrue(created.id.length > 0)
    }))

  it.effect("findValidByHash returns only live tokens", () =>
    Effect.gen(function*() {
      yield* insertUser("u-rt-hash", "rt-hash@test.local")
      yield* insertRefreshToken({
        userId: "u-rt-hash",
        tokenHash: "hash-valid",
        expiresAt: VALID_EXPIRES_AT,
      })
      yield* insertRefreshToken({
        userId: "u-rt-hash",
        tokenHash: "hash-revoked",
        expiresAt: VALID_EXPIRES_AT,
        revokedAt: 1,
      })
      yield* insertRefreshToken({
        userId: "u-rt-hash",
        tokenHash: "hash-expired",
        expiresAt: -1,
      })

      const repo = yield* RefreshTokenRepository
      const valid = yield* repo.findValidByHash(tokenHash("hash-valid"))
      assert.isTrue(Option.isSome(valid))
      assert.strictEqual(Option.getOrThrow(valid).tokenHash, "hash-valid")

      assert.isTrue(Option.isNone(yield* repo.findValidByHash(tokenHash("hash-revoked"))))
      assert.isTrue(Option.isNone(yield* repo.findValidByHash(tokenHash("hash-expired"))))
      assert.isTrue(Option.isNone(yield* repo.findValidByHash(tokenHash("hash-unknown"))))
    }))

  it.effect("findValidByUserID returns a live token or None", () =>
    Effect.gen(function*() {
      yield* insertUser("u-rt-user-valid", "rt-user-valid@test.local")
      yield* insertUser("u-rt-user-revoked", "rt-user-revoked@test.local")
      yield* insertUser("u-rt-user-empty", "rt-user-empty@test.local")
      yield* insertRefreshToken({
        userId: "u-rt-user-valid",
        tokenHash: "hash-u-valid",
        expiresAt: VALID_EXPIRES_AT,
      })
      yield* insertRefreshToken({
        userId: "u-rt-user-revoked",
        tokenHash: "hash-u-revoked",
        expiresAt: VALID_EXPIRES_AT,
        revokedAt: 1,
      })

      const repo = yield* RefreshTokenRepository
      const valid = yield* repo.findValidByUserID(userKey("u-rt-user-valid"))
      assert.isTrue(Option.isSome(valid))
      assert.strictEqual(Option.getOrThrow(valid).tokenHash, "hash-u-valid")

      assert.isTrue(Option.isNone(yield* repo.findValidByUserID(userKey("u-rt-user-revoked"))))
      assert.isTrue(Option.isNone(yield* repo.findValidByUserID(userKey("u-rt-user-empty"))))
    }))

  it.effect("revoke marks a live token revoked exactly once", () =>
    Effect.gen(function*() {
      yield* insertUser("u-rt-revoke", "rt-revoke@test.local")
      yield* insertRefreshToken({
        userId: "u-rt-revoke",
        tokenHash: "hash-revoke",
        expiresAt: VALID_EXPIRES_AT,
      })

      const repo = yield* RefreshTokenRepository
      const revoked = yield* repo.revoke(tokenHash("hash-revoke"))
      assert.isTrue(Option.isSome(revoked))
      assert.strictEqual(Option.getOrThrow(revoked).revokedAt, 0)

      // The token is no longer valid and cannot be revoked twice.
      assert.isTrue(Option.isNone(yield* repo.findValidByHash(tokenHash("hash-revoke"))))
      assert.isTrue(Option.isNone(yield* repo.revoke(tokenHash("hash-revoke"))))
    }))

  it.effect("revoke returns None for unknown and expired tokens", () =>
    Effect.gen(function*() {
      yield* insertUser("u-rt-revoke-miss", "rt-revoke-miss@test.local")
      yield* insertRefreshToken({
        userId: "u-rt-revoke-miss",
        tokenHash: "hash-revoke-expired",
        expiresAt: -1,
      })

      const repo = yield* RefreshTokenRepository
      assert.isTrue(Option.isNone(yield* repo.revoke(tokenHash("hash-revoke-unknown"))))
      assert.isTrue(Option.isNone(yield* repo.revoke(tokenHash("hash-revoke-expired"))))
    }))
})
