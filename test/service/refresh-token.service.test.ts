import { assert, layer } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { HasherService } from "@/services/hasher.service"
import { JWTService } from "@/services/jwt.service"
import { RefreshTokenService } from "@/services/refresh-token.service"
import { RefreshTokenRepository } from "@/repo/refresh-token.repo"
import { RefreshTokenValue, UserId } from "@/db/schema/brands"
import { TestServicesLive } from "../support/services"
import { insertUser } from "../support/seed"

const userId = (value: string) => Schema.decodeSync(UserId)(value)
const refreshToken = (value: string) => Schema.decodeSync(RefreshTokenValue)(value)

// A token value that was never issued by the service.
const unknownToken = refreshToken("unknown-refresh-token-value")

layer(TestServicesLive, { concurrent: false })("RefreshTokenService", (it) => {
  it.effect("issueToken stores a hashed token that consumeToken turns into a JWT", () =>
    Effect.gen(function*() {
      const service = yield* RefreshTokenService
      const hasher = yield* HasherService
      const jwt = yield* JWTService
      const repo = yield* RefreshTokenRepository
      yield* insertUser("u-rt-issue", "rt-issue@test.local", "seeker")

      const token = yield* service.issueToken(userId("u-rt-issue"), "Pixel 9")

      const hash = yield* hasher.hashRefreshToken(token)
      const stored = yield* repo.findValidByHash(hash)
      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(Option.getOrThrow(stored).deviceInfo, "Pixel 9")

      const accessToken = yield* service.consumeToken(token)
      const object = yield* jwt.verify(accessToken)
      assert.strictEqual(object.payload.id, "u-rt-issue")
      assert.strictEqual(object.payload.role, "seeker")
    }))

  it.effect("rotateToken issues a fresh single-use token and revokes the old one", () =>
    Effect.gen(function*() {
      const service = yield* RefreshTokenService
      yield* insertUser("u-rt-rotate", "rt-rotate@test.local")

      const original = yield* service.issueToken(userId("u-rt-rotate"), "Laptop")
      const rotated = yield* service.rotateToken(userId("u-rt-rotate"), "Laptop", original)

      assert.notStrictEqual(rotated, original)

      // The rotated-out token is single use and no longer validates.
      const replayed = yield* Effect.flip(service.consumeToken(original))
      assert.strictEqual(replayed._tag, "RefreshTokenNotFoundError")

      // The replacement is still good for a fresh access token.
      const accessToken = yield* service.consumeToken(rotated)
      assert.isString(accessToken)
    }))

  it.effect("rotateToken fails with RefreshTokenNotFoundError for unknown or spent tokens", () =>
    Effect.gen(function*() {
      const service = yield* RefreshTokenService
      yield* insertUser("u-rt-spent", "rt-spent@test.local")

      const unknown = yield* Effect.flip(
        service.rotateToken(userId("u-rt-spent"), "Phone", unknownToken),
      )
      assert.strictEqual(unknown._tag, "RefreshTokenNotFoundError")

      const original = yield* service.issueToken(userId("u-rt-spent"), "Phone")
      yield* service.rotateToken(userId("u-rt-spent"), "Phone", original)
      const spent = yield* Effect.flip(
        service.rotateToken(userId("u-rt-spent"), "Phone", original),
      )
      assert.strictEqual(spent._tag, "RefreshTokenNotFoundError")
    }))

  it.effect("consumeToken fails once the token has expired", () =>
    Effect.gen(function*() {
      const service = yield* RefreshTokenService
      yield* insertUser("u-rt-expiry", "rt-expiry@test.local")

      const token = yield* service.issueToken(userId("u-rt-expiry"), "Tablet")
      // issueToken expires tokens after 30 days; move the Effect clock past it.
      yield* TestClock.adjust("31 days")

      const error = yield* Effect.flip(service.consumeToken(token))
      assert.strictEqual(error._tag, "RefreshTokenNotFoundError")
    }))

  it.effect("consumeToken reports an orphaned token as UserNotFoundError", () =>
    Effect.gen(function*() {
      const service = yield* RefreshTokenService
      const sql = yield* SqlClient.SqlClient
      yield* insertUser("u-rt-orphan", "rt-orphan@test.local")
      const token = yield* service.issueToken(userId("u-rt-orphan"), "Desktop")

      // Referential integrity is enforced in production, so the only way a
      // valid token points at a missing user is a broken/foreign row. Disable
      // the check just long enough to leave that row behind, then restore it.
      yield* sql.unsafe("PRAGMA foreign_keys = OFF")
      yield* Effect.ensuring(
        sql.unsafe("DELETE FROM users WHERE id = ?", ["u-rt-orphan"]),
        sql.unsafe("PRAGMA foreign_keys = ON").pipe(Effect.orDie),
      )

      const error = yield* Effect.flip(service.consumeToken(token))
      assert.strictEqual(error._tag, "UserNotFoundError")
    }))

  it.effect("consumeToken fails with RefreshTokenNotFoundError for an unknown token", () =>
    Effect.gen(function*() {
      const service = yield* RefreshTokenService
      yield* insertUser("u-rt-unknown", "rt-unknown@test.local")

      const error = yield* Effect.flip(service.consumeToken(unknownToken))
      assert.strictEqual(error._tag, "RefreshTokenNotFoundError")
    }))

  it.effect("asCookie returns the refresh_token cookie the app sets", () =>
    Effect.gen(function*() {
      const service = yield* RefreshTokenService
      const [name, value, options] = yield* service.asCookie(unknownToken)

      assert.strictEqual(name, "refresh_token")
      assert.strictEqual(value, unknownToken)
      assert.isDefined(options)
      assert.strictEqual(options?.httpOnly, true)
      assert.strictEqual(options?.secure, true)
      assert.strictEqual(options?.path, "/")
      assert.strictEqual(options?.maxAge, 30 * 24 * 60 * 60 * 1000)
    }))
})
