import { Option, Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlError } from "@effect/sql";
import { NewRefreshToken, RefreshToken, RefreshTokenHash, RefreshTokenSchema } from "@/db/schema/RefreshToken";

export interface RefreshTokenRepository {
  readonly findByUserID: (id: number) => Effect.Effect<Option.Option<RefreshToken>, SqlError.SqlError>;
  readonly revokeToken: (hash: typeof RefreshTokenHash.Type) => Effect.Effect<void, SqlError.SqlError>;
  readonly new: (newToken: typeof NewRefreshToken.Type) => Effect.Effect<RefreshToken, SqlError.SqlError>;
  // readonly insert: (creds: { email: string, password: typeof PasswordHash.Type }) => Effect.Effect<Option.Option<User>, SqlError.SqlError>;
}

export const RefreshTokenRepository = Context.GenericTag<RefreshTokenRepository>("RefreshTokenRepository");

export const RefreshTokenRepositoryLive = Layer.effect(
  RefreshTokenRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    return {
      findByUserID: (id) =>
        Effect.gen(function*() {
          return yield* sql<RefreshToken>`
            SELECT *
              FROM refresh_tokens
             WHERE userId=${id};`
            .pipe(
              Effect.map(rows => rows[0]),
              Effect.map(Option.fromNullable)
            )
        }),
      revokeToken: (hash) =>
        Effect.gen(function*() {
          return yield* sql`
                UPDATE refresh_tokens
                   SET revoked_at=DATETIME("now")
                 WHERE token_hash=${hash}`
        }),
      new: ({ userId, tokenHash, expiresAt }) =>
        Effect.gen(function*() {
          return yield* sql<RefreshToken>`
          INSERT INTO refresh_tokens
                      (user_id, token_hash, expires_at)
               VALUES (${userId}, ${tokenHash}, ${expiresAt})
            RETURNING *;`
        }).pipe(
          Effect.map(row => row[0]),
          Effect.map(token => Schema.decodeSync(RefreshTokenSchema)(token))
        )
    }
  })
)
