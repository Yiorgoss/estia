import { PrivateApi } from "@/api/private";
import { JWTSchema } from "@/db/schema/brands";
import { ListerRepository } from "@/repo/lister.repo";
import { SeekerRepository } from "@/repo/seeker.repo";
import { UnauthorizedError } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { InternalError, UserService } from "@/services/user.service";
import { HttpApiBuilder } from "@effect/platform";
import { Effect, Option, Schema } from "effect";


export const UserHandler = HttpApiBuilder.group(
  PrivateApi,
  'user-group',
  (handlers) =>
    handlers
      .handle("me", ({ request }) =>
        Effect.gen(function*() {
          const jwtService = yield* JWTService
          const accessToken = yield* Schema.decodeUnknown(JWTSchema)(request.cookies['access_token'])
          const userJWT = yield* jwtService.verify(accessToken)
          const user = yield* jwtService.extractUser(userJWT)

          const listerRepo = yield* ListerRepository
          const seekerRepo = yield* SeekerRepository
          const userProfile = yield* Effect.if(
            user.role == 'lister',
            {
              onTrue: () => listerRepo
                .findByUserId(user.id)
                .pipe(
                  Effect.filterOrFail(
                    Option.isSome,
                    () => new InternalError()
                  ),
                  Effect.map(x => x.value),
                ),
              onFalse: () => seekerRepo
                .findByUserId(user.id)
                .pipe(
                  Effect.filterOrFail(
                    Option.isSome,
                    () => new InternalError()
                  ),
                  Effect.map(x => x.value),
                ),
            })
          return { user, userProfile }
        }).pipe(
          Effect.catchTags({
            ExpiredJWTError: (e) => Effect.fail(new UnauthorizedError({ cause: e._tag })),
            ParseError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
            InvalidJWTError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
            SqlError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
          })
        )
      )
      .handle("change-role", (req) =>
        Effect.gen(function*() {
          const jwtService = yield* JWTService
          const accessToken = yield* Schema.decodeUnknown(JWTSchema)(req.request.cookies['access_token'])
          const userJWT = yield* jwtService.verify(accessToken)
          const user = yield* jwtService.extractUser(userJWT)

          const newRole = user.role == 'lister' ? 'seeker' : 'lister'

          const userService = yield* UserService

          const newProfile = yield* userService.switchRoles(user.id, newRole)
          return { newProfile }

        })
          .pipe(
            Effect.catchTags({
              ExpiredJWTError: (e) => Effect.fail(new UnauthorizedError({ cause: e._tag })),
              ParseError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
              InvalidJWTError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
              // SqlError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
            })
          )
      )
)
