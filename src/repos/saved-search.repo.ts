import { SavedSearchId, UserId } from "@/db/schema/brands";
import {
  NewSavedSearch,
  SavedSearchRowSchema,
  type SavedSearch,
} from "@/db/schema/SavedSearch";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The saved-search repository. Every read and write is scoped by `user_id` in
 * the statement itself, so another account's row is never selected, updated, or
 * deleted - there is no path here that takes an id without its owner.
 *
 * Repositories fail only with `SqlError`; the service turns that into the
 * domain answer.
 */
export interface SavedSearchRepository {
  readonly create: (
    userId: typeof UserId.Type,
    values: typeof NewSavedSearch.Type,
  ) => Effect.Effect<SavedSearch, SqlError>;

  readonly listByUser: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<ReadonlyArray<SavedSearch>, SqlError>;

  readonly findByIdForUser: (
    userId: typeof UserId.Type,
    id: typeof SavedSearchId.Type,
  ) => Effect.Effect<Option.Option<SavedSearch>, SqlError>;

  readonly deleteForUser: (
    userId: typeof UserId.Type,
    id: typeof SavedSearchId.Type,
  ) => Effect.Effect<Option.Option<SavedSearch>, SqlError>;
}

export const SavedSearchRepository =
  Context.Service<SavedSearchRepository>("SavedSearchRepository");

const decodeSavedSearch = (row: Record<string, unknown>): SavedSearch =>
  Schema.decodeUnknownSync(SavedSearchRowSchema)(row);

// An `INSERT`/`DELETE ... RETURNING` statement that matched yields exactly one
// row; an empty result is a driver defect, so it dies and surfaces as a 500.
const decodeSingle = (rows: ReadonlyArray<Record<string, unknown>>): SavedSearch =>
  decodeSavedSearch(Option.getOrThrow(Option.fromNullishOr(rows[0])));

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
          const rows = yield* sql<Record<string, unknown>>`
              INSERT INTO saved_searches (
                       user_id, name, query, kind, region_code, min_price_minor, max_price_minor,
                min_size_sqm, max_size_sqm, furnished, ensuite, smoking, pets, available_from,
                    created_at
              )
              VALUES (
                       ${userId}, ${values.name}, ${values.query ?? null}, ${values.kind ?? null}, ${values.regionCode ?? null}, ${values.minPriceMinor ?? null}, ${values.maxPriceMinor ?? null},
                ${values.minSizeSqm ?? null}, ${values.maxSizeSqm ?? null}, ${toBit(values.furnished)}, ${toBit(values.ensuite)}, ${toBit(values.smoking)}, ${toBit(values.pets)}, ${toEpochMillis(values.availableFrom)},
                    ${now}
              )
              RETURNING *;`;
          return decodeSingle(rows);
        }),
      listByUser: (userId) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM saved_searches
             WHERE user_id = ${userId}
          ORDER BY created_at DESC, id DESC
            `.pipe(Effect.map((rows) => rows.map(decodeSavedSearch))),
      findByIdForUser: (userId, id) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM saved_searches
             WHERE id = ${id}
               AND user_id = ${userId}
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeSavedSearch)),
        ),
      deleteForUser: (userId, id) =>
        sql<Record<string, unknown>>`
            DELETE FROM saved_searches
             WHERE id = ${id}
               AND user_id = ${userId}
          RETURNING *;`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeSavedSearch)),
        ),
    } satisfies SavedSearchRepository;
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => Effect.logError("Saved search repository failed", { error })),
    ),
  ),
);
