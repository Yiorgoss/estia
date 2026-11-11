import { Option, Context, Effect, Layer, Schema } from "effect";
import { SeekerSchema } from "@/db/schema/Seeker";
import type { SeekerProfileInput } from "@/db/schema/Profile";
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
   * has typed a name. Asking twice - a retry, two tabs, the heal of a legacy
   * account - answers with the existing profile instead of tripping the
   * `user_id` uniqueness constraint.
   */
  readonly createForUser: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<typeof SeekerSchema.Type, SqlError>;
  /*
   * Write the details a person filled in, whether or not the row exists. A
   * registration-provisioned account updates its row; a legacy or partially
   * provisioned one gets the missing row opened by the same call, so a profile
   * is never unreachable because it was never created. The update is the whole
   * profile: a save replaces every field the form showed.
   */
  readonly upsertForUser: (
    userId: typeof UserId.Type,
    input: typeof SeekerProfileInput.Type,
  ) => Effect.Effect<typeof SeekerSchema.Type, SqlError>;
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
          Effect.map((row) => Schema.decodeUnknownSync(SeekerSchema)(row)),
        ),
      upsertForUser: (userId, input) =>
        sql<Record<string, unknown>>`
            INSERT INTO seekers (user_id, name, bio, date_of_birth, gender, smoking, pets, contact)
                 VALUES (${userId},
                         ${input.name},
                         ${input.bio ?? null},
                         ${input.dateOfBirth.getTime()},
                         ${input.gender},
                         ${input.smoking === true ? 1 : 0},
                         ${input.pets === true ? 1 : 0},
                         ${input.contact ?? null})
            ON CONFLICT (user_id) DO UPDATE SET
                    name = excluded.name,
                     bio = excluded.bio,
           date_of_birth = excluded.date_of_birth,
                gender = excluded.gender,
               smoking = excluded.smoking,
                  pets = excluded.pets,
               contact = excluded.contact
             RETURNING *;`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map((row) => Schema.decodeUnknownSync(SeekerSchema)(row)),
        ),
    } satisfies SeekerRepository; // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => Effect.logError("Seeker repository failed", { error })),
    ),
  ),
);
