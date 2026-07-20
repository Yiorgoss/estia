import { UserCredentials } from "@/db/schema/User"
import { UserRepository } from "@/repo/user-repo"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AuthTokens } from "./auth"
import { HasherService } from "./hasher"
import { JWTService } from "./jwt"
import { RefreshTokenService } from "./refresh-token"


export class UserAlreadyExistsError extends Schema.TaggedError<UserAlreadyExistsError>()("UserAlreadyExistsError", {},) { }
export class UserCouldNotBeCreated extends Schema.TaggedError<UserCouldNotBeCreated>()("UserCouldNotBeCreated", {},) { }

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {},) { }

export interface UserService {
  // getUser(id: string): Effect.Effect<User | null, Error>,
  registerUser(credentials: typeof UserCredentials.Type): Effect.Effect<AuthTokens, UserAlreadyExistsError | InternalError>
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

    return {
      registerUser: ({ email, password }) => Effect.gen(function*() {

        yield* userRepo
          .findByEmail(email)
          .pipe(
            Effect.catchTag("SqlError", () =>
              Effect.fail(new InternalError())
            ),
            Effect.filterOrFail(
              Option.isSome,
              () => new UserAlreadyExistsError()
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
        const refreshToken = yield* refreshTokenService.create(user.id)
        return { accessToken, refreshToken }
      }).pipe(
        Effect.catchTags({
          UserAlreadyExistsError: (e) => Effect.fail(e),
          HashError: () => Effect.fail(new InternalError()),
          SqlError: () => Effect.fail(new InternalError()),
          JWTSigningError: () => Effect.fail(new InternalError()),
          RefreshTokenServiceError: () => Effect.fail(new InternalError()),
        }),
      )
    }
  })
)
