import { Context, Effect, Layer, Option, Schema } from "effect"
import { UserRepository } from "../repo/user-repo"
import { JWT, JWTService } from "./jwt"
import { HasherService } from "./hasher"
import { RefreshTokenService } from "./refresh-token"
import { UserCredentialsType } from "@/db/schema/User"
import { RefreshTokenValue } from "@/db/schema/RefreshToken"
import { InternalError } from "./user"

export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentialsError",
  {},
) { }


export interface AuthTokens {
  readonly accessToken: JWT,
  readonly refreshToken: typeof RefreshTokenValue.Type
}

export class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    readonly login: (credentials: UserCredentialsType) => Effect.Effect<AuthTokens, InternalError | InvalidCredentialsError>
  }
>() { }

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function*() {
    const userRepo = yield* UserRepository
    const hasher = yield* HasherService
    const jwtService = yield* JWTService
    const refreshTokenService = yield* RefreshTokenService

    return {
      login: ({ email, password }) =>
        Effect.gen(function*() {
          const user = yield* userRepo.findByEmail(email).pipe(
            Effect.map(Option.getOrThrowWith(() => new InvalidCredentialsError()))
          )

          const valid = yield* hasher.verifyPassword(password, user.passwordHash)

          if (!valid) {
            return yield* Effect.fail(new InvalidCredentialsError())
          }

          const jwtToken = yield* jwtService.signUser(user)
          const refreshToken = yield* refreshTokenService.create(user.id)

          return {
            accessToken: jwtToken,
            refreshToken
          }
        }).pipe(
          Effect.catchTags({
            HashError: () => Effect.fail(new InternalError()),
            RefreshTokenServiceError: () => Effect.fail(new InternalError()),
            SqlError: () => Effect.fail(new InternalError()),
            JWTSigningError: () => Effect.fail(new InternalError())
          })
        )
    }
  })
)
