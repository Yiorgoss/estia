import { UserCredentials } from "@/db/schema/User"
import { UserRepository } from "@/repo/user-repo"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AuthService, AuthTokens, InvalidCredentialsError } from "./auth"
import { HasherService } from "./hasher"
import { JWTService } from "./jwt"
import { RefreshTokenService } from "./refresh-token"


export class UserAlreadyExistsError extends Schema.TaggedError<UserAlreadyExistsError>()(
  "UserAlreadyExistsError",
  { cause: Schema.String },
) { }

export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  { cause: Schema.String },
) { }

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {},) { }

export interface UserService {
  // getUser(id: string): Effect.Effect<User | null, Error>,
  loginUser: (credentials: typeof UserCredentials.Type, userAgent: string) =>
    Effect.Effect<AuthTokens, InvalidCredentialsError | InternalError>
  registerUser: (credentials: typeof UserCredentials.Type, userAgent: string) => Effect.Effect<AuthTokens, UserAlreadyExistsError | InternalError>
}

export const UserService =
  Context.GenericTag<UserService>("UserService")

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function*() {
    const userRepo = yield* UserRepository
    const hasherService = yield* HasherService
    const jwtService = yield* JWTService
    const refreshTokenService = yield* RefreshTokenService
    const authService = yield* AuthService

    return {
      loginUser: ({ email, password }, userAgent) => Effect.gen(function*() {
        return yield* authService.authenticate({ email, password }, userAgent)
      }),
      registerUser: ({ email, password }, userAgent) => Effect.gen(function*() {
        yield* userRepo
          .findByEmail(email)
          .pipe(
            Effect.filterOrFail(
              Option.isNone,
              () => new UserAlreadyExistsError({ cause: "User Exists" }),
            )
          )

        const hash = yield* hasherService.hashPassword(password)
        const user = yield* userRepo
          .insert({ email, password: hash })
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new InternalError()),
                onSome: Effect.succeed
              })
            )
          )
        const accessToken = yield* jwtService.signUser(user)
        const refreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
        return { accessToken, refreshToken }
      }).pipe(
        Effect.tapError((e) => Effect.logError(`Signup Failed - ${e.cause}`)),
        Effect.catchTags({
          UserAlreadyExistsError: (e) => Effect.fail(e),
          HashError: () => Effect.fail(new InternalError()),
          SqlError: () => Effect.fail(new InternalError()),
          JWTSigningError: () => Effect.fail(new InternalError()),
        }),
      )
    }
  })
)
