import { RefreshTokenHash, UserId } from "@/db/schema/brands";
import { NewRefreshToken, RefreshToken, RefreshTokenSchema } from "@/db/schema/RefreshToken";
import { decodeSingle, query, type RepositoryError } from "@/repos/errors";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

export interface RefreshTokenRepository {
  readonly findValidByUserID: (
    id: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<RefreshToken>, RepositoryError>;
  readonly findValidByHash: (
    hash: typeof RefreshTokenHash.Type,
  ) => Effect.Effect<Option.Option<RefreshToken>, RepositoryError>;
  readonly revoke: (
    hash: typeof RefreshTokenHash.Type,
  ) => Effect.Effect<Option.Option<RefreshToken>, RepositoryError>;
  /*
   * Every live token the account owns is revoked in one statement, so the
   * sessions on other devices and the leftovers of earlier sign-ins end
   * together. Rows that already ended - revoked or expired - are left as they
   * are; the count is how many sessions this call ended.
   */
  readonly revokeAllForUser: (id: typeof UserId.Type) => Effect.Effect<number, RepositoryError>;
  readonly new: (
    newToken: typeof NewRefreshToken.Type,
  ) => Effect.Effect<RefreshToken, RepositoryError>;
}

export const RefreshTokenRepository =
  Context.Service<RefreshTokenRepository>("RefreshTokenRepository");

export const RefreshTokenRepositoryLive = Layer.effect(
  RefreshTokenRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      revoke: (hash) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return yield* query(
            "RefreshTokenRepository.revoke",
            sql<RefreshToken>`
              UPDATE refresh_tokens
                 SET revoked_at = ${now}
               WHERE token_hash = ${hash}
                 AND revoked_at IS NULL
                 AND expires_at >= ${now}
           RETURNING *;`,
          ).pipe(
            Effect.map((rows) => rows[0]),
            Effect.map(Option.fromNullishOr),
          );
        }),
      revokeAllForUser: (id) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const revoked = yield* query(
            "RefreshTokenRepository.revokeAllForUser",
            sql<RefreshToken>`
              UPDATE refresh_tokens
                 SET revoked_at = ${now}
               WHERE user_id = ${id}
                 AND revoked_at IS NULL
                 AND expires_at >= ${now}
           RETURNING *;`,
          );
          return revoked.length;
        }),
      findValidByHash: (hash) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return yield* query(
            "RefreshTokenRepository.findValidByHash",
            sql<RefreshToken>`
            SELECT *
              FROM refresh_tokens
             WHERE token_hash=${hash}
               AND revoked_at IS NULL
               AND expires_at >= ${now}
               ;`,
          ).pipe(
            Effect.map((rows) => rows[0]),
            Effect.map(Option.fromNullishOr),
          );
        }),
      findValidByUserID: (id) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // const inOneHour = now + 60 * 60 * 1000
          return yield* query(
            "RefreshTokenRepository.findValidByUserID",
            sql<RefreshToken>`
            SELECT *
              FROM refresh_tokens
             WHERE user_id=${id}
               AND revoked_at IS NULL
               AND expires_at >= ${now}
               ;`,
          ).pipe(
            Effect.map((rows) => rows[0]),
            Effect.map(Option.fromNullishOr),
          );
        }),
      new: ({ userId, tokenHash, expiresAt, deviceInfo }) =>
        query(
          "RefreshTokenRepository.new",
          sql<Record<string, unknown>>`
          INSERT INTO refresh_tokens
                      (user_id, token_hash, device_info, expires_at)
               VALUES (${userId}, ${tokenHash}, ${deviceInfo}, ${expiresAt})
            RETURNING *;`,
        ).pipe(
          Effect.flatMap((rows) =>
            decodeSingle("RefreshTokenRepository.new", RefreshTokenSchema, rows),
          ),
        ),
    } satisfies RefreshTokenRepository;
  }),
);
