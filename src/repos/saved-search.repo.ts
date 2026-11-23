import { SavedSearchId, UserId } from "@/db/schema/brands";
import {
  type NewSavedSearch,
  SavedSearchRowSchema,
  type SavedSearch,
} from "@/db/schema/SavedSearch";
import { decodeRow, decodeRows, decodeSingle, query, type RepositoryError } from "@/repos/errors";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

/*
 * The saved-search repository. Every read and write is scoped by `user_id` in
 * the statement itself, so another account's row is never selected, updated, or
 * deleted - there is no path here that takes an id without its owner.
 *
 * Repositories fail only with `RepositoryError`; the service turns that into
 * the domain answer.
 */
export interface SavedSearchRepository {
  readonly create: (
    userId: typeof UserId.Type,
    values: NewSavedSearch,
  ) => Effect.Effect<SavedSearch, RepositoryError>;

  readonly listByUser: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<ReadonlyArray<SavedSearch>, RepositoryError>;

  readonly findByIdForUser: (
    userId: typeof UserId.Type,
    id: typeof SavedSearchId.Type,
  ) => Effect.Effect<Option.Option<SavedSearch>, RepositoryError>;

  readonly deleteForUser: (
    userId: typeof UserId.Type,
    id: typeof SavedSearchId.Type,
  ) => Effect.Effect<Option.Option<SavedSearch>, RepositoryError>;
}

export const SavedSearchRepository =
  Context.Service<SavedSearchRepository>("SavedSearchRepository");

// SQLite/D1 cannot bind a `Date`, so store the epoch milliseconds the
// `DateFromMillis` schema encodes to.
const toEpochMillis = (value: Date | null | undefined): number | null =>
  value instanceof Date ? value.getTime() : null;

// A nullable filter flag is stored as `0 | 1`, with `null` meaning "any".
const toBit = (value: boolean | null | undefined): number | null =>
  value == null ? null : value ? 1 : 0;

export const SavedSearchRepositoryLive = Layer.effect(
  SavedSearchRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      create: (userId, values) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* query(
            "SavedSearchRepository.create",
            sql<Record<string, unknown>>`
              INSERT INTO saved_searches (
                       user_id, name, kind, region_code, min_price_minor, max_price_minor,
                min_size_sqm, max_size_sqm, furnished, ensuite, smoking, pets, available_from,
                    created_at
              )
              VALUES (
                       ${userId}, ${values.name}, ${values.kind ?? null}, ${values.regionCode ?? null}, ${values.minPriceMinor ?? null}, ${values.maxPriceMinor ?? null},
                ${values.minSizeSqm ?? null}, ${values.maxSizeSqm ?? null}, ${toBit(values.furnished)}, ${toBit(values.ensuite)}, ${toBit(values.smoking)}, ${toBit(values.pets)}, ${toEpochMillis(values.availableFrom)},
                    ${now}
              )
              RETURNING *;`,
          );
          return yield* decodeSingle("SavedSearchRepository.create", SavedSearchRowSchema, rows);
        }),
      listByUser: (userId) =>
        query(
          "SavedSearchRepository.listByUser",
          sql<Record<string, unknown>>`
            SELECT *
              FROM saved_searches
             WHERE user_id = ${userId}
          ORDER BY created_at DESC, id DESC
            `,
        ).pipe(
          Effect.flatMap((rows) =>
            decodeRows("SavedSearchRepository.listByUser", SavedSearchRowSchema, rows),
          ),
        ),
      findByIdForUser: (userId, id) =>
        query(
          "SavedSearchRepository.findByIdForUser",
          sql<Record<string, unknown>>`
            SELECT *
              FROM saved_searches
             WHERE id = ${id}
               AND user_id = ${userId}
            `,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow(
                  "SavedSearchRepository.findByIdForUser",
                  SavedSearchRowSchema,
                  rows[0],
                ).pipe(Effect.map(Option.some)),
          ),
        ),
      deleteForUser: (userId, id) =>
        query(
          "SavedSearchRepository.deleteForUser",
          sql<Record<string, unknown>>`
            DELETE FROM saved_searches
             WHERE id = ${id}
               AND user_id = ${userId}
          RETURNING *;`,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow(
                  "SavedSearchRepository.deleteForUser",
                  SavedSearchRowSchema,
                  rows[0],
                ).pipe(Effect.map(Option.some)),
          ),
        ),
    } satisfies SavedSearchRepository;
  }),
);
