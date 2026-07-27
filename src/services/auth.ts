import { Context, Effect, Layer, Option, Schema } from "effect"
import { UserRepository } from "../repo/user-repo"
import { ExpiredJWTError, InvalidJWTError, JWT, JWTService } from "./jwt"
import { HasherService } from "./hasher"
import { RefreshTokenService } from "./refresh-token"
import { CurrentUser, UserCredentialsType } from "@/db/schema/User"
import { RefreshTokenValue } from "@/db/schema/RefreshToken"
import { InternalError, UserNotFoundError } from "./user"


export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentialsError",
  {},
  { httpApiStatus: 401 }
) { }

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  {},
  { httpApiStatus: 401 }
) { }


export interface AuthTokens {
  readonly accessToken: JWT,
  readonly refreshToken: typeof RefreshTokenValue.Type
}

export class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    readonly tokenAuthFlow: (tokens: AuthTokens, userAgent: string) =>
      Effect.Effect<{ tokens: AuthTokens, user: typeof CurrentUser.Type },
        InvalidJWTError | ExpiredJWTError | UserNotFoundError | UnauthorizedError | InternalError>
    readonly authenticate: (credentials: UserCredentialsType, userAgent: string) => Effect.Effect<AuthTokens, InternalError | InvalidCredentialsError>
    // readonly login: (credentials: UserCredentialsType, userAgent: string) => Effect.Effect<AuthTokens, InternalError | InvalidCredentialsError>
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
      tokenAuthFlow: ({ accessToken, refreshToken }, userAgent) =>
        Effect.gen(function*() {
          // use token for authentication.
          // 
          let jwtUser = yield* jwtService
            .verify(accessToken)
            .pipe(
              Effect.flatMap((value) => jwtService.extractUser(value)),
              Effect.catchTags({
                ExpiredJWTError: () => Effect.succeed(null)
              }),
            )

          if (jwtUser) {
            return { tokens: { accessToken, refreshToken }, user: jwtUser }
          }

          //JWT Expired -> attempt refresh
          const newAccessToken = yield* refreshTokenService
            .consumeToken(refreshToken)

          jwtUser = yield* jwtService
            .verify(newAccessToken)
            .pipe(
              Effect.flatMap(x => jwtService.extractUser(x))
            )

          const newRefreshToken = yield* refreshTokenService
            .rotateToken(jwtUser.id, userAgent, refreshToken)

          return {
            user: jwtUser,
            tokens: {
              accessToken: newAccessToken,
              refreshToken: newRefreshToken
            }
          }
        }).pipe(
          Effect.tapError((err) => Effect.log({ err })),
        ),
      authenticate: ({ email, password }, userAgent) =>
        Effect.gen(function*() {
          const user = yield* userRepo
            .findByEmail(email)
            .pipe(
              Effect.map(Option.getOrThrowWith(() => new InvalidCredentialsError()))
            )
          yield* hasher
            .verifyPassword(password, user.passwordHash)
            .pipe(
              Effect.filterOrFail(
                (bool) => bool,
                () => new InvalidCredentialsError()))

          const refreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
          const jwtToken = yield* jwtService.signUser(user)
          return { accessToken: jwtToken, refreshToken }
        }).pipe(
          Effect.tapError((e) => Effect.logError(`Authentication Failed - ${e.cause}, ${e}`)),
          Effect.catchTags({
            SqlError: (e) => Effect.fail(new InternalError({ cause: e.cause })),
            HashError: () => Effect.fail(new InternalError()),
            JWTSigningError: () => Effect.fail(new InternalError())
          })
        )
      // login: ({ email, password }, userAgent) =>
      //   Effect.gen(function*() {
      //     const user = yield* userRepo.findByEmail(email).pipe(
      //       Effect.map(Option.getOrThrowWith(() => new InvalidCredentialsError()))
      //     )

      //     const valid = yield* hasher.verifyPassword(password, user.passwordHash)

      //     if (!valid) {
      //       return yield* Effect.fail(new InvalidCredentialsError())
      //     }

      //     const refreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
      //     const jwtToken = yield* jwtService.signUser(user)

      //     return {
      //       accessToken: jwtToken,
      //       refreshToken
      //     }
      //   }).pipe(
      //     Effect.tapError((e) => Effect.logError(`Authentication Failed - ${e.cause}, ${e}`)),
      //     Effect.catchTags({
      //       SqlError: (e) => Effect.fail(new InternalError({ cause: e.cause })),
      //       HashError: () => Effect.fail(new InternalError()),
      //       JWTSigningError: () => Effect.fail(new InternalError())
      //     })
      //   )
    }
  })
)
