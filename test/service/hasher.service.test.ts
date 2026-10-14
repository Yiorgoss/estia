import { assert, layer } from "@effect/vitest"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { HashError, HasherService, HasherServiceLive } from "@/services/hasher.service"
import { RefreshTokenValue, UserPasswordHash } from "@/db/schema/brands"

const passwordHash = (value: string) => Schema.decodeSync(UserPasswordHash)(value)
const refreshToken = (value: string) => Schema.decodeSync(RefreshTokenValue)(value)

// `HasherServiceLive` has no dependencies, so it is the whole test layer.
layer(HasherServiceLive)("HasherService", (it) => {
  it.effect("hashPassword emits a self-describing scrypt PHC string", () =>
    Effect.gen(function*() {
      const hasher = yield* HasherService
      const hash = yield* hasher.hashPassword("correct horse battery staple")

      assert.strictEqual(typeof hash, "string")
      // $scrypt$ln=14,p=1,r=8$<salt>$<derived key>, with scryptOptions N=16384.
      assert.match(hash, /^\$scrypt\$ln=14,p=1,r=8\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/)
      // The decoded value is a valid branded `UserPasswordHash`.
      assert.doesNotThrow(() => passwordHash(hash))
    }))

  it.effect("hashPassword is salted, so the same password hashes differently", () =>
    Effect.gen(function*() {
      const hasher = yield* HasherService
      const first = yield* hasher.hashPassword("same-password")
      const second = yield* hasher.hashPassword("same-password")
      assert.notStrictEqual(first, second)
    }))

  it.effect("verifyPassword accepts the right password and rejects the wrong one", () =>
    Effect.gen(function*() {
      const hasher = yield* HasherService
      const hash = yield* hasher.hashPassword("open-sesame")

      const accepted = yield* hasher.verifyPassword("open-sesame", hash)
      assert.isTrue(accepted)

      const rejected = yield* hasher.verifyPassword("not-the-password", hash)
      assert.isFalse(rejected)
    }))

  it.effect("verifyPassword fails with HashError when the PHC string is malformed", () =>
    Effect.gen(function*() {
      const hasher = yield* HasherService

      const missingSalt = yield* Effect.flip(
        hasher.verifyPassword("pw", passwordHash("$scrypt$ln=15,r=8,p=1")),
      )
      assert.strictEqual(missingSalt._tag, "HashError")

      const missingHash = yield* Effect.flip(
        hasher.verifyPassword("pw", passwordHash("$scrypt$ln=15,r=8,p=1$c2FsdA")),
      )
      assert.strictEqual(missingHash._tag, "HashError")

      const missingParams = yield* Effect.flip(
        hasher.verifyPassword("pw", passwordHash("$scrypt$p=1$c2FsdA$aGFzaA")),
      )
      assert.strictEqual(missingParams._tag, "HashError")
      assert.isTrue(missingParams instanceof HashError)
    }))

  it.effect("hashRefreshToken is a deterministic sha256", () =>
    Effect.gen(function*() {
      const hasher = yield* HasherService
      const token = refreshToken("refresh-token-value")

      const first = yield* hasher.hashRefreshToken(token)
      const second = yield* hasher.hashRefreshToken(token)

      assert.strictEqual(first, second)
      assert.strictEqual(
        first,
        createHash("sha256").update(token).digest("hex"),
      )
    }))
})
