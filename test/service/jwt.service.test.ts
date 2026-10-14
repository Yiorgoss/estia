import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { SignJWT } from "jose"
import {
  ExpiredJWTError,
  InvalidJWTError,
  JWTService,
  JWTServiceLive,
} from "@/services/jwt.service"
import { User } from "@/db/schema/User"
import { JWTSchema, UserId, UserPasswordHash } from "@/db/schema/brands"
import { TEST_DOMAIN, TEST_JWT_SECRET, TestConfigLive } from "../support/services"

const userId = (value: string) => Schema.decodeSync(UserId)(value)
const passwordHash = (value: string) => Schema.decodeSync(UserPasswordHash)(value)
const jwtToken = (value: string) => Schema.decodeSync(JWTSchema)(value)

// Flip the first character of the signature. The final base64url character can
// carry only padding bits, so changing it is not guaranteed to alter the signed
// bytes; the first character always does.
const tamperSignature = (token: string) => {
  const parts = token.split(".")
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`
  return parts.join(".")
}

const secretU8 = new TextEncoder().encode(TEST_JWT_SECRET)

const testUser: User = {
  id: userId("jwt-user"),
  email: "jwt@test.local",
  passwordHash: passwordHash("hash"),
  role: "seeker",
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

// Re-sign an otherwise valid token while overriding one of the claims, so each
// test can isolate the failure the service maps back to a typed error.
const signWith = (claims: {
  readonly issuer?: string
  readonly audience?: string
  readonly issuedAt?: number
  readonly expiresAt?: number
}) =>
  Effect.promise(() =>
    new SignJWT({ id: testUser.id, role: testUser.role })
      .setSubject(testUser.id)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(claims.issuedAt ?? Math.floor(Date.now() / 1000))
      .setIssuer(claims.issuer ?? `${TEST_DOMAIN}/login`)
      .setAudience(claims.audience ?? TEST_DOMAIN)
      .setExpirationTime(claims.expiresAt ?? "1h")
      .sign(secretU8),
  )

const TestLive = JWTServiceLive.pipe(Layer.provide(TestConfigLive))

layer(TestLive)("JWTService", (it) => {
  it.effect("signUser/verify round trip preserves the user claims", () =>
    Effect.gen(function*() {
      const jwt = yield* JWTService
      const token = yield* jwt.signUser(testUser)
      const object = yield* jwt.verify(token)

      assert.strictEqual(object.payload.id, "jwt-user")
      assert.strictEqual(object.payload.role, "seeker")
      assert.strictEqual(object.payload.sub, "jwt-user")
      assert.strictEqual(object.payload.iss, `${TEST_DOMAIN}/login`)
      assert.strictEqual(object.payload.aud, TEST_DOMAIN)
      assert.isAtLeast(object.payload.exp, object.payload.iat)
      assert.strictEqual(object.protectedHeader.alg, "HS256")
    }))

  it.effect("extractUser keeps only the id and role", () =>
    Effect.gen(function*() {
      const jwt = yield* JWTService
      const token = yield* jwt.signUser(testUser)
      const object = yield* jwt.verify(token)
      const current = yield* jwt.extractUser(object)

      assert.deepStrictEqual(current, { id: "jwt-user", role: "seeker" })
    }))

  it.effect("asCookie returns the access_token cookie the app sets", () =>
    Effect.gen(function*() {
      const jwt = yield* JWTService
      const token = yield* jwt.signUser(testUser)
      const [name, value, options] = yield* jwt.asCookie(token)

      assert.strictEqual(name, "access_token")
      assert.strictEqual(value, token)
      assert.isDefined(options)
      assert.strictEqual(options?.httpOnly, true)
      assert.strictEqual(options?.secure, true)
      assert.strictEqual(options?.path, "/")
      assert.strictEqual(options?.maxAge, 60 * 60 * 1000)
    }))

  it.effect("verify rejects a tampered token with InvalidJWTError", () =>
    Effect.gen(function*() {
      const jwt = yield* JWTService
      const token = yield* jwt.signUser(testUser)
      const tampered = jwtToken(tamperSignature(token))

      const error = yield* Effect.flip(jwt.verify(tampered))
      assert.strictEqual(error._tag, "InvalidJWTError")
      assert.isTrue(error instanceof InvalidJWTError)
    }))

  it.effect("verify reports an expired token as ExpiredJWTError", () =>
    Effect.gen(function*() {
      const jwt = yield* JWTService
      const now = Math.floor(Date.now() / 1000)
      const expired = jwtToken(yield* signWith({ issuedAt: now - 7200, expiresAt: now - 3600 }))

      const error = yield* Effect.flip(jwt.verify(expired))
      assert.strictEqual(error._tag, "ExpiredJWTError")
      assert.isTrue(error instanceof ExpiredJWTError)
    }))

  it.effect("verify reports a wrong issuer or audience as InvalidJWTError", () =>
    Effect.gen(function*() {
      const jwt = yield* JWTService

      const wrongIssuer = jwtToken(yield* signWith({ issuer: "http://evil.test/login" }))
      const issuerError = yield* Effect.flip(jwt.verify(wrongIssuer))
      assert.strictEqual(issuerError._tag, "InvalidJWTError")
      assert.isTrue(issuerError instanceof InvalidJWTError)

      const wrongAudience = jwtToken(yield* signWith({ audience: "http://evil.test" }))
      const audienceError = yield* Effect.flip(jwt.verify(wrongAudience))
      assert.strictEqual(audienceError._tag, "InvalidJWTError")
      assert.isTrue(audienceError instanceof InvalidJWTError)
    }))
})
