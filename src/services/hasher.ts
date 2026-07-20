import { Context, Effect, Layer, Schema } from "effect";
import { argon2id, argon2Verify, sha256 } from "hash-wasm";
// import { argon2id, hash, verify } from "argon2"

import { PasswordHash } from "@/db/schema/User";
import { RefreshToken, RefreshTokenHash, RefreshTokenValue } from "@/db/schema/RefreshToken";

export class HashError extends Schema.TaggedError<HashError>()(
  "HashError",
  {
    message: Schema.optional(Schema.String)
  },
) { }

export interface HasherService {
  hashPassword(password: string): Effect.Effect<typeof PasswordHash.Type, HashError>;
  verifyPassword(password: string, hash: typeof PasswordHash.Type): Effect.Effect<boolean, HashError>;
  hashRefreshToken(token: typeof RefreshTokenValue.Type): Effect.Effect<typeof RefreshTokenHash.Type, HashError>;
}

export const HasherService = Context.GenericTag<HasherService>("PasswordHasher");

export const HasherServiceLive = Layer.effect(
  HasherService,
  Effect.gen(function*() {

    return {
      hashPassword: (password) =>
        Effect.tryPromise({
          try: () =>
            argon2id({
              password,
              salt: crypto.getRandomValues(new Uint8Array(16)),
              memorySize: 65536,
              hashLength: 32,
              iterations: 3,
              parallelism: 4,
              outputType: "encoded"
            }),
          catch: () => new HashError({ message: 'hashing function failed' })
        }).pipe(
          Effect.map(hash => Schema.decodeUnknownSync(PasswordHash)(hash))
        ),
      verifyPassword: (password, hash) =>
        Effect.tryPromise({
          try: () => argon2Verify({ password, hash }),
          catch: () => new HashError({ message: 'hash verification failed' })
        }),
      hashRefreshToken: (token) =>
        Effect.tryPromise({
          try: () => sha256(token),
          catch: () => new HashError({ message: "hashing function failed" })
        }).pipe(
          Effect.map(hash => Schema.decodeSync(RefreshTokenHash)(hash))
        )
    }
  })
)

