import { Option, Context, Effect, Layer, Schema, Clock } from "effect"
import { SqlClient, SqlError } from "@effect/sql";
import { NewRefreshToken, RefreshToken, RefreshTokenSchema } from "@/db/schema/RefreshToken";
import { RefreshTokenHash } from "@/db/schema/brands";


export class RefreshTokenNotFoundError extends Schema.TaggedError<RefreshTokenNotFoundError>()(
  "RefreshTokenNotFoundError",
  {},) { }

export interface RefreshTokenRepository {
  readonly findValidByUserID: (id: number) =>
    Effect.Effect<Option.Option<RefreshToken>, SqlError.SqlError>;
  readonly findValidByHash: (hash: typeof RefreshTokenHash.Type) =>
    Effect.Effect<Option.Option<RefreshToken>, SqlError.SqlError>;
  readonly revoke: (hash: typeof RefreshTokenHash.Type) =>
    Effect.Effect<Option.Option<RefreshToken>, SqlError.SqlError>;
  readonly new: (newToken: typeof NewRefreshToken.Type) =>
    Effect.Effect<RefreshToken, SqlError.SqlError>;
}

export const RefreshTokenRepository = Context.GenericTag<RefreshTokenRepository>("RefreshTokenRepository");

export const RefreshTokenRepositoryLive = Layer.effect(
  RefreshTokenRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    return {
      revoke: (hash) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          return yield* sql<RefreshToken>`
              UPDATE refresh_tokens
                 SET revoked_at = ${now}
               WHERE token_hash = ${hash}
           RETURNING *;`
            .pipe(
              Effect.map(rows => rows[0]),
              Effect.map(Option.fromNullable)
            )
        }),
      findValidByHash: (hash) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          return yield* sql<RefreshToken>`
            SELECT *
              FROM refresh_tokens
             WHERE token_hash=${hash}
               AND revoked_at IS NULL
               AND expires_at >= ${now}
               ;`
            .pipe(
              Effect.map(rows => rows[0]),
              Effect.map(Option.fromNullable)
            )
        }),
      findValidByUserID: (id) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          // const inOneHour = now + 60 * 60 * 1000
          return yield* sql<RefreshToken>`
            SELECT *
              FROM refresh_tokens
             WHERE userId=${id}
               AND revoked_at IS NULL
               AND expires_at >= ${now}
               ;`
            .pipe(
              Effect.map(rows => rows[0]),
              Effect.map(Option.fromNullable)
            )
        }),
      new: ({ userId, tokenHash, expiresAt, deviceInfo }) =>
        Effect.gen(function*() {
          return yield* sql<RefreshToken>`
          INSERT INTO refresh_tokens
                      (user_id, token_hash, device_info, expires_at)
               VALUES (${userId}, ${tokenHash}, ${deviceInfo}, ${expiresAt})
            RETURNING *;`
        }).pipe(
          Effect.map(row => row[0]),
          Effect.map(token => Schema.decodeSync(RefreshTokenSchema)(token))
        )

    }
  })
)
