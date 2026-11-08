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
   * A lister row needs nothing but the user id: `ownership` has a default and
   * `name` is nullish, so a listing profile can be opened before anyone has
   * filled one in. That is what makes switching to listing provisionable.
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
