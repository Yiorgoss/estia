import { HttpApiSchema } from "@effect/platform";
import { Config, Context, Data, Effect, Layer, Schema } from "effect";
import { JWTPayload, jwtVerify, SignJWT } from "jose";
import { JWTClaimValidationFailed, JWTExpired } from "jose/errors";

export class JWTSigningError extends Schema.TaggedError<JWTSigningError>()(
  "JWTSigningError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  },
  HttpApiSchema.annotations({ status: 500 })
) { }

export class JWTValidateError extends Schema.TaggedError<JWTValidateError>()(
  "JWTValidateError",
  {
    reason: Schema.Literal("InvalidIssuer", "InvalidAudience", 'Expired', 'Unknown'),
    cause: Schema.optional(Schema.Unknown)
  },
  HttpApiSchema.annotations({ status: 401 })
) { }

export interface JWTI {
  sign(payload: object): Effect.Effect<string, JWTSigningError>;
  verify(token: string): Effect.Effect<object, JWTValidateError>;
}

export class JWT extends Context.Tag("JWT")<
  JWT,
  JWTI
>() { }

export const JWTLive = Layer.effect(
  JWT,
  Effect.gen(function*() {
    // const domain = yield* Config.string("DOMAIN")
    const domain = "123xxx"
    const secret = yield* Config.string("JWT_SECRET")
    const secretU8 = new TextEncoder().encode(secret)

    return {
      sign: (payload: JWTPayload) =>
        Effect.tryPromise({
          try: () => new SignJWT(payload)
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setIssuer(`https://${domain}/login`)
            .setAudience(`https://${domain}`)
            .setExpirationTime('1h')
            .sign(secretU8),
          catch: (error) => new JWTSigningError({ message: "errrrrr XD", cause: error })
        }),
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
    } satisfies JWTI;
  })
)
