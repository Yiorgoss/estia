import { CurrentUser, UserCredentials, UserSchema } from "@/db/schema/User"
import { UserRepository } from "@/repo/user.repo"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HasherService } from "./hasher.service"
import { ListerSchema } from "@/db/schema/Lister"
import { UserId, UserRoles } from "@/db/schema/brands"
import { SeekerSchema } from "@/db/schema/Seeker"
import { SeekerRepository } from "@/repo/seeker.repo"
import { ListerRepository } from "@/repo/lister.repo"


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
  registerUser: (credentials: typeof UserCredentials.Type, userAgent: string) => Effect.Effect<typeof UserSchema.Type, UserAlreadyExistsError | InternalError>
  switchRoles: (id: typeof UserId.Type, role: typeof UserRoles.Type) =>
    Effect.Effect<typeof SeekerSchema.Type | typeof ListerSchema.Type, never>
}

export const UserService =
  Context.GenericTag<UserService>("UserService")

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function*() {
    const userRepo = yield* UserRepository
    const hasherService = yield* HasherService
    const listerRepo = yield* ListerRepository
    const seekerRepo = yield* SeekerRepository

    return {
      switchRoles: (id, role) =>
        Effect.gen(function*() {
          if (role === 'admin') return yield* Effect.dieMessage('cannot update to admin')
          const user = yield* userRepo.updateRole(id, role)
            .pipe(
              Effect.filterOrDieMessage(
                Option.isSome,
                "Cannot update Role"
              ),
              Effect.map(some => some.value)
            )
          if (user.role == 'seeker') {
            return yield* seekerRepo
              .findByUserId(id)
              .pipe(
                Effect.filterOrDieMessage(
                  Option.isSome,
                  "Cannot find Seeker"
                ),
                Effect.map(some => some.value)
              )
          } else if (user.role == 'lister') {
            return yield* listerRepo
              .findByUserId(id)
              .pipe(
                Effect.filterOrDieMessage(
                  Option.isSome,
                  "Cannot find Lister"
                ),
                Effect.map(some => some.value)
              )
          }
          return yield* Effect.dieMessage("role didnt match shit")
        }).pipe(Effect.catchAll(e => Effect.dieMessage(e.cause as string))),
      registerUser: ({ email, password }) => Effect.gen(function*() {
        yield* userRepo
          .findByEmail(email)
          .pipe(
            Effect.filterOrFail(
              Option.isNone,
              () => new UserAlreadyExistsError({ cause: "User Exists" }),
            )
          )

        const hash = yield* hasherService.hashPassword(password)
        return yield* userRepo
          .insert({ email, password: hash })
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new InternalError()),
                onSome: Effect.succeed
              })
            )
          )
        // const accessToken = yield* jwtService.signUser(user)
        // const refreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
        // return { accessToken, refreshToken }
      }).pipe(
        Effect.tapError((e) => Effect.logError(`Signup Failed - ${e.cause}`)),
        Effect.catchTags({
          UserAlreadyExistsError: (e) => Effect.fail(e),
          HashError: () => Effect.fail(new InternalError()),
          SqlError: () => Effect.fail(new InternalError()),
          // JWTSigningError: () => Effect.fail(new InternalError()),
        }),
      )
    }
  })
)
