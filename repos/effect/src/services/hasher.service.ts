import { Context, Effect, Layer, Schema } from "effect";
import { createHash, scrypt } from 'node:crypto';
import { serialize, deserialize } from "@phc/format"
import { RefreshTokenHash, RefreshTokenValue, UserPasswordHash } from "@/db/schema/brands";

export class HashError extends Schema.TaggedError<HashError>()(
  "HashError",
  {
    cause: Schema.String
  },
) { }

export interface HasherService {
  hashPassword(password: string): Effect.Effect<typeof UserPasswordHash.Type, HashError>;
  verifyPassword(password: string, hash: typeof UserPasswordHash.Type): Effect.Effect<boolean, HashError>;
  hashRefreshToken(token: typeof RefreshTokenValue.Type): Effect.Effect<typeof RefreshTokenHash.Type, HashError>;
}

export const HasherService = Context.Service<HasherService>("PasswordHasher");

export const scryptOptions = {
  N: 16384, //cost
  r: 8,//blockSize
  p: 1, //parallelization
}

export const HasherServiceLive = Layer.effect(
  HasherService,
  Effect.gen(function*() {

    return {
      hashPassword: (password) => Effect.gen(function*() {
        const salt = crypto.getRandomValues(new Uint8Array(16))

        return yield* Effect.callback<string, HashError>(
          (resume) => {
            scrypt(
              password,
              salt,
              32,
              scryptOptions,
              (err, derivedKey) => {
                if (err) {
                  return resume(Effect.fail(new HashError({ cause: String(err) })))
                }
                const ln = Math.log2(scryptOptions.N)
                if (!Number.isSafeInteger(ln)) {
                  return resume(Effect.fail(new HashError({ cause: "use a cost value that is a power of 2" })))
                }
                const phcString = serialize({
                  id: 'scrypt',
                  hash: Buffer.from(derivedKey),
                  salt: Buffer.from(salt),
                  params: {
                    ln,
                    p: scryptOptions.p,
                    r: scryptOptions.r
                  }
                })
                resume(Effect.succeed(phcString))
              }
            )
          })
      }).pipe(
        Effect.map(hash => Schema.decodeUnknownSync(UserPasswordHash)(hash))
      ),
      verifyPassword: (password, checkHash) =>
        Effect.callback<boolean, HashError>(
          (resume) => {
            const { salt, params, hash } = deserialize(checkHash)

            // ugh  untyped libs
            if (!salt) return resume(Effect.fail(new HashError({ cause: "Error verifying - no salt in hash" })))
            if (!hash) return resume(Effect.fail(new HashError({ cause: "Error verifying - no hash" })))
            if (!params || params.ln === undefined || params.r === undefined || params.p === undefined) {
              return resume(Effect.fail(new HashError({ cause: `Error verifying - wrong params expected - ln,p,r got - ${Object.keys(params ?? {})}` })))
            }

            scrypt(
              password,
              salt,
              32,
              { N: 2 ** Number(params.ln), r: Number(params.r), p: Number(params.p) },
              (err, derivedKey) => {

                if (err) return resume(Effect.fail(new HashError({ cause: String(err) })))
                if (Buffer.from(derivedKey).equals(Buffer.from(hash))) return resume(Effect.succeed(true))
                resume(Effect.succeed(false))
              }
            )
          }
        ),
      hashRefreshToken: (token) => Effect.succeed(createHash('sha256')
        .update(token)
        .digest('hex'))
        .pipe(
          Effect.map(hash => Schema.decodeSync(RefreshTokenHash)(hash))
        )
    }
  })
)
