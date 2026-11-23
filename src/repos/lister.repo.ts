import { UserId } from "@/db/schema/brands";
import { ListerSchema } from "@/db/schema/Lister";
import type { ListerProfileInput } from "@/db/schema/Profile";
import { decodeRow, decodeSingle, query, type RepositoryError } from "@/repos/errors";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

export interface ListerRepository {
  readonly findByUserId: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<typeof ListerSchema.Type>, RepositoryError>;
  /*
   * Ensure the user has a listing profile and answer with it. A lister row needs
   * nothing but the user id: `ownership` has a default and `name` is nullish, so
   * a listing profile can be opened before anyone has filled one in. Asking
   * twice - a double click, a retry, two tabs - answers with the same profile
   * instead of tripping the `user_id` uniqueness constraint.
   */
  readonly createForUser: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<typeof ListerSchema.Type, RepositoryError>;
  /*
   * Write the details a person filled in, whether or not the row exists, so a
   * legacy account is repaired by the same call that saves a normal one. The
   * update is the whole profile: a save replaces the name and the ownership the
   * form showed.
   */
  readonly upsertForUser: (
    userId: typeof UserId.Type,
    input: typeof ListerProfileInput.Type,
  ) => Effect.Effect<typeof ListerSchema.Type, RepositoryError>;
}

export const ListerRepository = Context.Service<ListerRepository>("ListerRepository");

export const ListerRepositoryLive = Layer.effect(
  ListerRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      findByUserId: (userId) =>
        query(
          "ListerRepository.findByUserId",
          sql<Record<string, unknown>>`
            SELECT *
              FROM listers
             WHERE user_id=${userId}
            `,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow("ListerRepository.findByUserId", ListerSchema, rows[0]).pipe(
                  Effect.map(Option.some),
                ),
          ),
        ),
      createForUser: (userId) =>
        query(
          "ListerRepository.createForUser",
          sql<Record<string, unknown>>`
            INSERT INTO listers (user_id)
                 VALUES (${userId})
            ON CONFLICT (user_id) DO UPDATE SET user_id = excluded.user_id
             RETURNING *;`,
        ).pipe(
          Effect.flatMap((rows) =>
            decodeSingle("ListerRepository.createForUser", ListerSchema, rows),
          ),
        ),
      upsertForUser: (userId, input) =>
        query(
          "ListerRepository.upsertForUser",
          sql<Record<string, unknown>>`
            INSERT INTO listers (user_id, name, ownership)
                 VALUES (${userId}, ${input.name ?? null}, ${input.ownership})
            ON CONFLICT (user_id) DO UPDATE SET
                    name = excluded.name,
               ownership = excluded.ownership
             RETURNING *;`,
        ).pipe(
          Effect.flatMap((rows) =>
            decodeSingle("ListerRepository.upsertForUser", ListerSchema, rows),
          ),
        ),
    } satisfies ListerRepository;
  }),
);
