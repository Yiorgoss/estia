import { Option, Context, Effect, Layer, Schema } from "effect";
import { SeekerSchema } from "@/db/schema/Seeker";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { UserId } from "@/db/schema/brands";

export interface SeekerRepository {
  readonly findByUserId: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<typeof SeekerSchema.Type>, SqlError>;
  /*
   * Ensure the user has a seeking profile and answer with it. Every seeking
   * field a person fills in themselves is nullish (see migration 0006), so a
   * profile can be opened from the user id alone at registration, before anyone
   * has typed a name. Asking twice - a retry, two tabs, a heal of a half-applied
   * registration - answers with the existing profile instead of tripping the
   * `user_id` uniqueness constraint.
   *
   * The answer is an `Option` so a caller that needs the row before it points a
   * role at it can tell "opened or already there" from "no answer at all"
   * without mistaking one for the other.
   */
  readonly createForUser: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<typeof SeekerSchema.Type>, SqlError>;
}

export const SeekerRepository = Context.Service<SeekerRepository>("SeekerRepository");

export const SeekerRepositoryLive = Layer.effect(
  SeekerRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      findByUserId: (userId) =>
        Effect.gen(function* () {
          return yield* sql<Record<string, unknown>>`
            SELECT *
              FROM seekers
             WHERE user_id=${userId}
            `.pipe(
            Effect.map((rows) => rows[0]),
            Effect.map(Option.fromNullishOr),
            Effect.map(Option.map((row) => Schema.decodeUnknownSync(SeekerSchema)(row))),
          );
        }),
      createForUser: (userId) =>
        sql<Record<string, unknown>>`
            INSERT INTO seekers (user_id)
                 VALUES (${userId})
            ON CONFLICT (user_id) DO UPDATE SET user_id = excluded.user_id
             RETURNING *;`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map((row) => Schema.decodeUnknownSync(SeekerSchema)(row))),
        ),
    } satisfies SeekerRepository; // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => Effect.logError("Seeker repository failed", { error })),
    ),
  ),
);
