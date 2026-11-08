import { Option, Context, Effect, Layer, Schema } from "effect";
import { ListerSchema } from "@/db/schema/Lister";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { UserId } from "@/db/schema/brands";

export interface ListerRepository {
  readonly findByUserId: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<typeof ListerSchema.Type>, SqlError>;
  /*
   * Ensure the user has a listing profile and answer with it. A lister row needs
   * nothing but the user id: `ownership` has a default and `name` is nullish, so
   * a listing profile can be opened before anyone has filled one in. Asking
   * twice - a double click, a retry, two tabs - answers with the same profile
   * instead of tripping the `user_id` uniqueness constraint.
   */
  readonly createForUser: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<typeof ListerSchema.Type, SqlError>;
}

export const ListerRepository = Context.Service<ListerRepository>("ListerRepository");

export const ListerRepositoryLive = Layer.effect(
  ListerRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      findByUserId: (userId) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM listers
             WHERE user_id=${userId}
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map((row) => Schema.decodeUnknownSync(ListerSchema)(row))),
        ),
      createForUser: (userId) =>
        sql<Record<string, unknown>>`
            INSERT INTO listers (user_id)
                 VALUES (${userId})
            ON CONFLICT (user_id) DO UPDATE SET user_id = excluded.user_id
             RETURNING *;`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map((row) => Schema.decodeUnknownSync(ListerSchema)(row)),
        ),
    } satisfies ListerRepository; // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => Effect.logError("Lister repository failed", { error })),
    ),
  ),
);
