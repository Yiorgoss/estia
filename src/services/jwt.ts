import { User } from "@/db/schema/User";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { jwtVerify, SignJWT } from "jose";
import { JWTClaimValidationFailed, JWTExpired } from "jose/errors";

export const JWTSchema = Schema.String.pipe(
  Schema.brand("JWT")
)

export type JWT = typeof JWTSchema.Type

export class JWTSigningError extends Schema.TaggedError<JWTSigningError>()(
  "JWTSigningError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  },
) { }

export class JWTValidateError extends Schema.TaggedError<JWTValidateError>()(
  "JWTValidateError",
  {
    reason: Schema.Literal("InvalidIssuer", "InvalidAudience", 'Expired', 'Unknown'),
    cause: Schema.optional(Schema.Unknown)
  },
) { }

export interface JWTService {
  signUser(user: User): Effect.Effect<JWT, JWTSigningError>;
  verify(token: string): Effect.Effect<object, JWTValidateError>;
}

export const JWTService = Context.GenericTag<JWTService>("JWTService");

export const JWTServiceLive = Layer.effect(
  JWTService,
  Effect.gen(function*() {
    // const domain = yield* Config.string("DOMAIN")
    const domain = "123xxx"
    const secret = yield* Config.string("JWT_SECRET")
    const secretU8 = new TextEncoder().encode(secret)

    return {
      signUser: (user: User) =>
        Effect.tryPromise({
          try: () => new SignJWT({
            id: user.id,
            email: user.email,
            role: user.role
          })
            .setSubject(user.id.toString())
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setIssuer(`https://${domain}/login`)
            .setAudience(`https://${domain}`)
            .setExpirationTime('1h')
            .sign(secretU8),
          catch: (error) => new JWTSigningError({ message: "errrrrr XD", cause: error })
        }).pipe(
          Effect.map(token => Schema.decodeSync(JWTSchema)(token))
        ),
      verify: (token: string) =>
        Effect.tryPromise({
          try: () => jwtVerify(token, secretU8, {
            issuer: `https://${domain}/login`,
            audience: `https://${domain}`
          }),
          catch: (error) => {
            if (error instanceof JWTClaimValidationFailed) {
              if (error.claim === "iss") {
                return new JWTValidateError({
                  reason: "InvalidIssuer",
                  cause: error
                })
              }
              if (error.claim === "aud") {
                return new JWTValidateError({
                  reason: "InvalidAudience",
                  cause: error
                })
              }
            }
            if (error instanceof JWTExpired) {
              return new JWTValidateError({
                reason: "Expired",
                cause: error
              })
            }
            return new JWTValidateError({
              reason: "Unknown",
              cause: error
            })
          }
        })
    };
  })
)
