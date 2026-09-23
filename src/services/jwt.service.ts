import { JWTSchema, UserId, UserRoles } from "@/db/schema/brands";
import { CurrentUser, User } from "@/db/schema/User";
import { Cookies } from "@effect/platform";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { jwtVerify, SignJWT } from "jose";
import { JWTClaimValidationFailed, JWTExpired } from "jose/errors";


// export type JWT = typeof JWTSchema.Type

export class JWTSigningError extends Schema.TaggedError<JWTSigningError>()(
  "JWTSigningError",
  {
    cause: Schema.Unknown
  },
) { }

export class InvalidJWTError extends Schema.TaggedError<InvalidJWTError>()(
  "InvalidJWTError",
  {
    cause: Schema.Unknown
  },
) { }
export class ExpiredJWTError extends Schema.TaggedError<ExpiredJWTError>()(
  "ExpiredJWTError",
  {
    cause: Schema.Unknown,
  },
) { }

export const JWTObjectSchema = Schema.Struct({
  payload: Schema.Struct({
    id: UserId,
    role: UserRoles,
    sub: Schema.String,
    iat: Schema.Number,
    iss: Schema.String,
    aud: Schema.String,
    exp: Schema.Number
  }),
  protectedHeader: Schema.Struct({
    alg: Schema.String
  })
})
export interface JWTService {
  asCookie(token: typeof JWTSchema.Type):
    Effect.Effect<[name: string, value: string, options?: Cookies.Cookie["options"]],
      never>
  signUser(user: User): Effect.Effect<typeof JWTSchema.Type, JWTSigningError>;
  verify(token: typeof JWTSchema.Type): Effect.Effect<typeof JWTObjectSchema.Type, InvalidJWTError | ExpiredJWTError>;
  extractUser(object: typeof JWTObjectSchema.Type): Effect.Effect<typeof CurrentUser.Type, InvalidJWTError>
}

export const JWTService = Context.GenericTag<JWTService>("JWTService");

export const JWTServiceLive = Layer.effect(
  JWTService,
  Effect.gen(function*() {
    // const domain = yield* Config.string("DOMAIN")
    const domain = yield* Config.string("DOMAIN")
    const secret = yield* Config.string("JWT_SECRET")
    const secretU8 = new TextEncoder().encode(secret)

    return {
      asCookie: (token) => Effect.succeed(
        [
          "access_token",
          token,
          {
            httpOnly: true,
            secure: true,
            path: "/",
            maxAge: 60 * 60 * 1000
          }
        ],
      ),
      signUser: (user: User) =>
        Effect.tryPromise({
          try: () => new SignJWT({
            id: user.id,
            role: user.role
          })
            .setSubject(user.id.toString())
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setIssuer(`${domain}/login`)
            .setAudience(`${domain}`)
            .setExpirationTime('1h')
            .sign(secretU8),
          catch: (error) => new JWTSigningError({ cause: error })
        }).pipe(
          Effect.map(token => Schema.decodeUnknownSync(JWTSchema)(token))
        ),
      extractUser: (object) =>
        Effect.try(
          () => Schema.decodeUnknownSync(CurrentUser)({ id: object.payload.id, role: object.payload.role })
        )
          .pipe(
            Effect.catchTags({
              UnknownException: (e) => Effect.fail(new InvalidJWTError({ cause: e.cause }))
            })
          ),
      verify: (token) => Effect.tryPromise({
        try: () => jwtVerify<typeof JWTObjectSchema.Type>(token, secretU8, {
          issuer: `${domain}/login`,
          audience: `${domain}`
        }),
        catch: (error) => {
          if (error instanceof JWTClaimValidationFailed) {
            if (error.claim === "iss") {
              return new InvalidJWTError({
                cause: error
              })
            }
            if (error.claim === "aud") {
              return new InvalidJWTError({
                cause: error
              })
            }
          }
          if (error instanceof JWTExpired) {
            return new ExpiredJWTError({
              cause: error
            })
          }
          return new InvalidJWTError({
            cause: error
          })
        }
      }).pipe(
        Effect.map(value => Schema.decodeUnknownSync(JWTObjectSchema)(value))
      )
    };
  })
)
