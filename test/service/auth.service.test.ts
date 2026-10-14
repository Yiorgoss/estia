import { assert, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AuthService } from "@/services/auth.service"
import { JWTService } from "@/services/jwt.service"
import { RefreshTokenService } from "@/services/refresh-token.service"
import { UserService } from "@/services/user.service"
import { JWTSchema, RefreshTokenValue } from "@/db/schema/brands"
import { TestServicesLive } from "../support/services"

const jwtToken = (value: string) => Schema.decodeSync(JWTSchema)(value)
const refreshToken = (value: string) => Schema.decodeSync(RefreshTokenValue)(value)

// Flip the first character of the signature. The final base64url character can
// carry only padding bits, so changing it is not guaranteed to alter the signed
// bytes; the first character always does.
const tamperSignature = (token: string) => {
  const parts = token.split(".")
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`
  return parts.join(".")
}

const unknownRefreshToken = refreshToken("unknown-refresh-token-value")

// Register a fresh user through the same service the register endpoint uses,
// then log in and return the persisted user plus the issued token pair.
const registerAndAuthenticate = (email: string, password: string) =>
  Effect.gen(function*() {
    const users = yield* UserService
    const auth = yield* AuthService

    const user = yield* users.registerUser({ email, password }, "vitest")
    const tokens = yield* auth.authenticate({ email, password }, "vitest")
    return { user, tokens }
  })

layer(TestServicesLive, { concurrent: false })("AuthService", (it) => {
  it.effect("authenticate issues an access token and refresh token for valid credentials", () =>
    Effect.gen(function*() {
      const jwt = yield* JWTService
      const { user, tokens } = yield* registerAndAuthenticate(
        "auth-login@test.local",
        "hunter2",
      )

      assert.isString(tokens.accessToken)
      assert.isString(tokens.refreshToken)

      const object = yield* jwt.verify(tokens.accessToken)
      assert.strictEqual(object.payload.id, user.id)
      assert.strictEqual(object.payload.role, "user")
    }))

  it.effect("authenticate fails with InvalidCredentialsError for a wrong password", () =>
    Effect.gen(function*() {
      const auth = yield* AuthService
      yield* registerAndAuthenticate("auth-wrong-pw@test.local", "right-password")

      const error = yield* Effect.flip(
        auth.authenticate(
          { email: "auth-wrong-pw@test.local", password: "wrong-password" },
          "vitest",
        ),
      )
      assert.strictEqual(error._tag, "InvalidCredentialsError")
    }))

  it.effect("authenticate fails with InvalidCredentialsError for an unknown email", () =>
    Effect.gen(function*() {
      const auth = yield* AuthService

      const error = yield* Effect.flip(
        auth.authenticate({ email: "nobody@test.local", password: "pw" }, "vitest"),
      )
      assert.strictEqual(error._tag, "InvalidCredentialsError")
    }))

  it.effect("tokenAuthFlow accepts a valid access token and echoes the token pair", () =>
    Effect.gen(function*() {
      const auth = yield* AuthService
      const { user, tokens } = yield* registerAndAuthenticate(
        "auth-access@test.local",
        "hunter2",
      )

      const result = yield* auth.tokenAuthFlow(
        { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
        "vitest",
      )

      assert.strictEqual(result.user.id, user.id)
      assert.strictEqual(result.user.role, "user")
      assert.strictEqual(result.tokens.accessToken, tokens.accessToken)
      assert.strictEqual(result.tokens.refreshToken, tokens.refreshToken)
    }))

  it.effect("tokenAuthFlow rotates the refresh token when the access token is invalid", () =>
    Effect.gen(function*() {
      const auth = yield* AuthService
      const refresh = yield* RefreshTokenService
      const jwt = yield* JWTService
      const { user, tokens } = yield* registerAndAuthenticate(
        "auth-refresh@test.local",
        "hunter2",
      )

      const tamperedAccess = jwtToken(tamperSignature(tokens.accessToken))

      const result = yield* auth.tokenAuthFlow(
        { accessToken: tamperedAccess, refreshToken: tokens.refreshToken },
        "vitest",
      )

      assert.strictEqual(result.user.id, user.id)
      // A fresh refresh token replaced the rotated-out one. The access token is
      // intentionally not compared: HS256 signing is deterministic, so two
      // signUser calls in the same second can produce byte-identical JWTs.
      assert.notStrictEqual(result.tokens.refreshToken, tokens.refreshToken)
      assert.isString(result.tokens.accessToken)
      assert.isString(result.tokens.refreshToken)

      const object = yield* jwt.verify(jwtToken(result.tokens.accessToken!))
      assert.strictEqual(object.payload.id, user.id)

      // The refresh token that was rotated out is now single use.
      const replayed = yield* Effect.flip(refresh.consumeToken(tokens.refreshToken))
      assert.strictEqual(replayed._tag, "RefreshTokenNotFoundError")
    }))

  it.effect("tokenAuthFlow fails with UnauthorizedError when no tokens are supplied", () =>
    Effect.gen(function*() {
      const auth = yield* AuthService

      const error = yield* Effect.flip(auth.tokenAuthFlow({}, "vitest"))
      assert.strictEqual(error._tag, "UnauthorizedError")
    }))

  it.effect("tokenAuthFlow forwards a missing refresh token as RefreshTokenNotFoundError", () =>
    Effect.gen(function*() {
      const auth = yield* AuthService

      const error = yield* Effect.flip(
        auth.tokenAuthFlow({ refreshToken: unknownRefreshToken }, "vitest"),
      )
      assert.strictEqual(error._tag, "RefreshTokenNotFoundError")
    }))
})
