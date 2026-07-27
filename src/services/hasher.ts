import { Context, Effect, Layer, Schema } from "effect";
import { createHash, scrypt } from 'node:crypto';
import { serialize, deserialize } from "@phc/format"

import { PasswordHash } from "@/db/schema/User";
import { RefreshTokenHash, RefreshTokenValue } from "@/db/schema/RefreshToken";

export class HashError extends Schema.TaggedError<HashError>()(
  "HashError",
  {
    cause: Schema.String
  },
) { }

export interface HasherService {
  hashPassword(password: string): Effect.Effect<typeof PasswordHash.Type, HashError>;
  verifyPassword(password: string, hash: typeof PasswordHash.Type): Effect.Effect<boolean, HashError>;
  hashRefreshToken(token: typeof RefreshTokenValue.Type): Effect.Effect<typeof RefreshTokenHash.Type, HashError>;
}

export const HasherService = Context.GenericTag<HasherService>("PasswordHasher");

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

        return yield* Effect.async<string, HashError>(
          (resume) => {
            scrypt(
              password,
              salt,
              32,
              scryptOptions,
              (err, derivedKey) => {
                if (err) {
                  resume(Effect.fail(new HashError({ cause: String(err) })))
                }
                const ln = Math.log2(scryptOptions.N)
                if (!Number.isSafeInteger(ln)) {
                  resume(Effect.fail(new HashError({ cause: "use a cost value that is a power of 2" })))
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
        Effect.map(hash => Schema.decodeUnknownSync(PasswordHash)(hash))
      ),
      verifyPassword: (password, checkHash) =>
        Effect.async<boolean, HashError>(
          (resume) => {
            const { salt, params, hash } = deserialize(checkHash)

            // ugh  untyped libs
            if (!salt) new HashError({ cause: "Error verifying - no salt in hash" })
            if (!hash) new HashError({ cause: "Error verifying - no hash" })
            if (!params || !params.N || !params.r || !params.p) new HashError({ cause: `Error verifying - wrong params expected - N,p,r got - ${Object.keys(params!)}` })

            scrypt(
              password,
              salt!,
              32,
              params!,
              (err, derivedKey) => {

                if (err) resume(Effect.fail(new HashError({ cause: String(err) })))
                if (Buffer.from(derivedKey).equals(Buffer.from(hash!))) resume(Effect.succeed(true))
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

