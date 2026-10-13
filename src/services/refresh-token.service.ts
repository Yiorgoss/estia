import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { HashError, HasherService } from "./hasher.service";
import { RefreshTokenNotFoundError, RefreshTokenRepository } from "@/repo/refresh-token.repo";
import type { SqlError } from "effect/sql/SqlError";

import { JWTService } from "./jwt.service";
import { UserRepository } from "@/repo/user.repo";
import { InternalError, UserNotFoundError } from "./user.service";

import { Cookies } from "effect/http";
import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";


// export class InvalidRefreshTokenError extends Schema.TaggedError<InvalidRefreshTokenError>()(
//   "InvalidRefreshTokenError",
//   {},) { }

export interface RefreshTokenService {
  asCookie: (token: typeof RefreshTokenValue.Type) =>
    Effect.Effect<[name: string, value: string, options?: Cookies.Cookie["options"]],
      never>
  issueToken: (id: typeof UserId.Type, userAgent: string) =>
    Effect.Effect<typeof RefreshTokenValue.Type,
      HashError | SqlError>;
  consumeToken: (token: typeof RefreshTokenValue.Type) =>
    Effect.Effect<typeof JWTSchema.Type,
      InternalError | UserNotFoundError>;
  rotateToken: (userId: typeof UserId.Type, userAgent: string, token: typeof RefreshTokenValue.Type) =>
    Effect.Effect<typeof RefreshTokenValue.Type,
      InternalError>
}
export const RefreshTokenService = Context.Service<RefreshTokenService>("RefreshTokenService");

export const RefreshTokenServiceLive = Layer.effect(
  RefreshTokenService,
  Effect.gen(function*() {
    // const domain = yield* Config.string("DOMAIN")
    const hasher = yield* HasherService
    const refreshTokenRepo = yield* RefreshTokenRepository
    // const refreshTokenService = yield* RefreshTokenService
    const userRepo = yield* UserRepository
    const jwtService = yield* JWTService

    return {
      asCookie: (token) =>
        Effect.succeed([
          'refresh_token',
          token,
          {
            http: true,
            secure: true,
            path: "/",
            maxAge: 30 * 24 * 60 * 60 * 1000 // one month
          }
        ]),
      issueToken: (id, userAgent) =>
        Effect.gen(function*() {
          const token = Schema.decodeSync(RefreshTokenValue)(
            crypto.getRandomValues(new Uint8Array(32)).toHex())

          const hash = yield* hasher.hashRefreshToken(token)
          const now = yield* Clock.currentTimeMillis
          const expiresAt = now + 30 * 24 * 60 * 60 * 1000

          yield* refreshTokenRepo
            .new({
              userId: id,
              tokenHash: hash,
              expiresAt,
              deviceInfo: userAgent
            })

          return token
        }),
      rotateToken: (userId, userAgent, token) =>
        Effect.gen(function*() {
          const oldToken = yield* hasher.hashRefreshToken(token)
          const now = yield* Clock.currentTimeMillis
          const expiresAt = now + 30 * 24 * 60 * 60 * 1000

          yield* refreshTokenRepo.revoke(oldToken)

          const newTokenValue = Schema.decodeSync(RefreshTokenValue)(
            crypto.getRandomValues(new Uint8Array(32)).toHex())

          const newTokenHash = yield* hasher.hashRefreshToken(newTokenValue)

          // const tokenHash = yield*  
          yield* refreshTokenRepo.new({
            userId,
            expiresAt,
            deviceInfo: userAgent,
            tokenHash: newTokenHash
          })
          return newTokenValue
        }).pipe(
          Effect.catchTags({
            HashError: () =>
              Effect.fail(new InternalError()),
            SqlError: () =>
              Effect.fail(new InternalError()),
          })
        ),
      consumeToken: (token) =>
        Effect.gen(function*() {
          //does token exist and is valid
          const tokenHash = yield* hasher.hashRefreshToken(token)
          const revokedToken = yield* refreshTokenRepo
            .revoke(tokenHash)
            .pipe(
              Effect.map(Option.getOrThrowWith(
                () => new RefreshTokenNotFoundError())))

          // get associated user
          const user = yield* userRepo
            .findById(revokedToken.userId)
            .pipe(
              Effect.map(Option.getOrThrowWith(
                () => new UserNotFoundError({ cause: "User Not Found" }))))

          //construct jwt
          const newJWT = yield* jwtService.signUser(user)
          return newJWT
          // const newRefreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
          // return { accessToken: newJWT, refreshToken: newRefreshToken }
        }).pipe(
          Effect.catchTags({
            HashError: () =>
              Effect.fail(new InternalError()),
            SqlError: () =>
              Effect.fail(new InternalError()),
            JWTSigningError: () =>
              Effect.fail(new InternalError())
          })
        ),
    }
  })
)
