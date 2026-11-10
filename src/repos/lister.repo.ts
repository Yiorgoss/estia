import { Option, Context, Effect, Layer, Schema } from "effect";
import { ListerSchema } from "@/db/schema/Lister";
import type { ListerProfileInput } from "@/db/schema/Profile";
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
  /*
   * Write the details a person filled in, whether or not the row exists, so a
   * legacy account is repaired by the same call that saves a normal one. The
   * update is the whole profile: a save replaces the name and the ownership the
   * form showed.
   */
  readonly upsertForUser: (
    userId: typeof UserId.Type,
    input: typeof ListerProfileInput.Type,
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
      upsertForUser: (userId, input) =>
        sql<Record<string, unknown>>`
            INSERT INTO listers (user_id, name, ownership)
                 VALUES (${userId}, ${input.name ?? null}, ${input.ownership})
            ON CONFLICT (user_id) DO UPDATE SET
                    name = excluded.name,
               ownership = excluded.ownership
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
