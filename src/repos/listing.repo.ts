import { ListingId, UserId } from "@/db/schema/brands";
import {
  CreateListingInput,
  ListingPage,
  ListingPageRequest,
  ListingSchema,
  ListingSearchFilters,
  ListingStatus,
  UpdateListingInput,
} from "@/db/schema/Listing";
import { ListingPinRows } from "@/db/schema/ListingPin";
import {
  decodeRow,
  decodeRows,
  decodeSingle,
  query,
  type RepositoryError,
  type RowDecodeError,
} from "@/repos/errors";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

/*
 * The listings repository. Every method is a single statement because D1 has no
 * interactive transactions through this driver (`SqlClient.withTransaction`
 * dies at runtime), so there is nothing to wrap and no partial-write window.
 *
 * Repositories fail only with `RepositoryError`; domain errors belong to the
 * service.
 */
export interface ListingRepository {
  readonly create: (
    ownerId: typeof UserId.Type,
    values: typeof CreateListingInput.Type,
  ) => Effect.Effect<typeof ListingSchema.Type, RepositoryError>;

  readonly findById: (
    id: typeof ListingId.Type,
  ) => Effect.Effect<Option.Option<typeof ListingSchema.Type>, RepositoryError>;

  readonly listByOwner: (
    ownerId: typeof UserId.Type,
    page: typeof ListingPageRequest.Type,
  ) => Effect.Effect<typeof ListingPage.Type, RepositoryError>;

  readonly search: (
    filters: typeof ListingSearchFilters.Type,
    page: typeof ListingPageRequest.Type,
  ) => Effect.Effect<typeof ListingPage.Type, RepositoryError>;

  readonly listPinned: (
    filters: typeof ListingSearchFilters.Type,
    limit: number,
  ) => Effect.Effect<typeof ListingPinRows.Type, RepositoryError>;

  readonly update: (
    id: typeof ListingId.Type,
    ownerId: typeof UserId.Type,
    values: typeof UpdateListingInput.Type,
  ) => Effect.Effect<Option.Option<typeof ListingSchema.Type>, RepositoryError>;

  readonly setStatus: (
    id: typeof ListingId.Type,
    ownerId: typeof UserId.Type,
    from: ReadonlyArray<typeof ListingStatus.Type>,
    to: typeof ListingStatus.Type,
  ) => Effect.Effect<Option.Option<typeof ListingSchema.Type>, RepositoryError>;
}

export const ListingRepository = Context.Service<ListingRepository>("ListingRepository");

// SQLite/D1 cannot bind a `Date`, so store the epoch milliseconds the
// `DateFromMillis` schema encodes to.
const toEpochMillis = (value: Date | null | undefined): number | null =>
  value instanceof Date ? value.getTime() : null;

// `BooleanFromBit` is persisted as an integer flag.
const toBit = (value: boolean | null | undefined): number | null =>
  value == null ? null : value ? 1 : 0;

// Inserts keep the NOT NULL default of the four room bits.
const toInsertBit = (value: boolean | undefined): number => (value === true ? 1 : 0);

// `1` when the caller supplied the field, `0` when it was absent. SQLite has no
// "was this parameter provided" flag, so a nullable column is only overwritten
// when its value is not `undefined`; an explicit `null` clears it.
const provided = (value: unknown): number => (value === undefined ? 0 : 1);

// Fetch one extra row to learn whether another page exists without a `COUNT`.
const toPage = (
  operation: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  limit: number,
): Effect.Effect<typeof ListingPage.Type, RowDecodeError> => {
  const hasMore = rows.length > limit;
  return decodeRows(operation, ListingSchema, hasMore ? rows.slice(0, limit) : rows).pipe(
    Effect.map((items) => {
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          hasMore && last !== undefined
            ? { createdAt: last.createdAt.getTime(), id: last.id }
            : null,
      };
    }),
  );
};

// The map is bounded, not paged: the extra row proves there is one older pin
// that did not fit, and the caller reports that as `truncated`.
const toPinRows = (
  operation: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  limit: number,
): Effect.Effect<typeof ListingPinRows.Type, RowDecodeError> => {
  const truncated = rows.length > limit;
  return decodeRows(operation, ListingSchema, truncated ? rows.slice(0, limit) : rows).pipe(
    Effect.map((items) => ({ items, truncated })),
  );
};

export const ListingRepositoryLive = Layer.effect(
  ListingRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /*
     * Keyset predicate for the deterministic `(created_at DESC, id DESC)` sort:
     * the next page starts strictly after the cursor row, so rows inserted while
     * a caller pages cannot duplicate or skip a listing.
     */
    const cursorClause = (cursor: (typeof ListingPageRequest.Type)["cursor"]) =>
      cursor === undefined
        ? sql``
        : sql`AND (created_at < ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND id < ${cursor.id}))`;

    /*
     * The feed and the map share one filter predicate, so a filter that narrows
     * the list narrows the pins too and the two surfaces cannot disagree about
     * what "matching listing" means.
     */
    const filterClause = (filters: typeof ListingSearchFilters.Type) => sql`
      ${filters.kind != null ? sql`AND kind = ${filters.kind}` : sql``}
      ${filters.regionCode != null ? sql`AND region_code = ${filters.regionCode}` : sql``}
      ${filters.minPriceMinor != null ? sql`AND price_minor >= ${filters.minPriceMinor}` : sql``}
      ${filters.maxPriceMinor != null ? sql`AND price_minor <= ${filters.maxPriceMinor}` : sql``}
      ${filters.minSizeSqm != null ? sql`AND size_sqm >= ${filters.minSizeSqm}` : sql``}
      ${filters.maxSizeSqm != null ? sql`AND size_sqm <= ${filters.maxSizeSqm}` : sql``}
      ${filters.furnished != null ? sql`AND furnished = ${toBit(filters.furnished)}` : sql``}
      ${filters.ensuite != null ? sql`AND ensuite = ${toBit(filters.ensuite)}` : sql``}
      ${filters.smoking != null ? sql`AND smoking = ${toBit(filters.smoking)}` : sql``}
      ${filters.pets != null ? sql`AND pets = ${toBit(filters.pets)}` : sql``}
      ${filters.availableFrom != null ? sql`AND available_from >= ${toEpochMillis(filters.availableFrom)}` : sql``}
    `;

    return {
      create: (ownerId, values) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* query(
            "ListingRepository.create",
            sql<Record<string, unknown>>`
              INSERT INTO listings (
                       kind, owner_id, status, title, description, price_minor, currency,
                region_code, lat, lng, size_sqm, available_from, furnished, ensuite,
                    smoking, pets, created_at, updated_at
              )
              VALUES (
                       ${values.kind}, ${ownerId}, 'draft', ${values.title}, ${values.description ?? null}, ${values.priceMinor}, 'EUR',
                ${values.regionCode}, ${values.lat ?? null}, ${values.lng ?? null}, ${values.sizeSqm ?? null}, ${toEpochMillis(values.availableFrom)}, ${toInsertBit(values.furnished)}, ${toInsertBit(values.ensuite)},
                    ${toInsertBit(values.smoking)}, ${toInsertBit(values.pets)}, ${now}, ${now}
              )
              RETURNING *;`,
          );
          return yield* decodeSingle("ListingRepository.create", ListingSchema, rows);
        }),
      findById: (id) =>
        query(
          "ListingRepository.findById",
          sql<Record<string, unknown>>`
            SELECT *
              FROM listings
             WHERE id = ${id}
            `,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow("ListingRepository.findById", ListingSchema, rows[0]).pipe(
                  Effect.map(Option.some),
                ),
          ),
        ),
      listByOwner: (ownerId, page) =>
        query(
          "ListingRepository.listByOwner",
          sql<Record<string, unknown>>`
            SELECT *
              FROM listings
             WHERE owner_id = ${ownerId}
                 ${cursorClause(page.cursor)}
          ORDER BY created_at DESC, id DESC
             LIMIT ${page.limit + 1}
            `,
        ).pipe(Effect.flatMap((rows) => toPage("ListingRepository.listByOwner", rows, page.limit))),
      search: (filters, page) =>
        query(
          "ListingRepository.search",
          sql<Record<string, unknown>>`
            SELECT *
              FROM listings
             WHERE status = 'published'
                 ${filterClause(filters)}
                 ${cursorClause(page.cursor)}
          ORDER BY created_at DESC, id DESC
             LIMIT ${page.limit + 1}
            `,
        ).pipe(Effect.flatMap((rows) => toPage("ListingRepository.search", rows, page.limit))),
      listPinned: (filters, limit) =>
        // Published with a coordinate, newest first. Drafts, unlisted rows,
        // half-populated coordinate pairs, and room-wanted ads never reach the
        // map at all - they are excluded in SQL, not filtered in JS. A
        // room-wanted ad's coordinate is where a person wants to live, not
        // where a property is, so it is not a pin.
        query(
          "ListingRepository.listPinned",
          sql<Record<string, unknown>>`
            SELECT *
              FROM listings
             WHERE status = 'published'
               AND lat IS NOT NULL
               AND lng IS NOT NULL
               AND kind <> 'room_wanted'
                 ${filterClause(filters)}
          ORDER BY created_at DESC, id DESC
             LIMIT ${limit + 1}
            `,
        ).pipe(Effect.flatMap((rows) => toPinRows("ListingRepository.listPinned", rows, limit))),
      update: (id, ownerId, values) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* query(
            "ListingRepository.update",
            sql<Record<string, unknown>>`
                UPDATE listings
                   SET title = COALESCE(${values.title ?? null}, title),
                       description = CASE WHEN ${provided(values.description)} = 1 THEN ${values.description ?? null} ELSE description END,
                       price_minor = COALESCE(${values.priceMinor ?? null}, price_minor),
                       region_code = COALESCE(${values.regionCode ?? null}, region_code),
                       lat = CASE WHEN ${provided(values.lat)} = 1 THEN ${values.lat ?? null} ELSE lat END,
                       lng = CASE WHEN ${provided(values.lng)} = 1 THEN ${values.lng ?? null} ELSE lng END,
                       size_sqm = CASE WHEN ${provided(values.sizeSqm)} = 1 THEN ${values.sizeSqm ?? null} ELSE size_sqm END,
                       available_from = CASE WHEN ${provided(values.availableFrom)} = 1 THEN ${toEpochMillis(values.availableFrom)} ELSE available_from END,
                       furnished = COALESCE(${toBit(values.furnished)}, furnished),
                       ensuite = COALESCE(${toBit(values.ensuite)}, ensuite),
                       smoking = COALESCE(${toBit(values.smoking)}, smoking),
                       pets = COALESCE(${toBit(values.pets)}, pets),
                       updated_at = ${now}
                 WHERE id = ${id}
                   AND owner_id = ${ownerId}
              RETURNING *;`,
          );
          if (rows[0] === undefined) return Option.none();
          return Option.some(yield* decodeRow("ListingRepository.update", ListingSchema, rows[0]));
        }),
      setStatus: (id, ownerId, from, to) =>
        // An empty source set can never match, and `sql.in` on an empty list
        // produces an invalid predicate, so no statement is sent.
        from.length === 0
          ? Effect.succeedNone
          : Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const rows = yield* query(
                "ListingRepository.setStatus",
                sql<Record<string, unknown>>`
                    UPDATE listings
                       SET status = ${to},
                           published_at = CASE WHEN ${to} = 'published' THEN ${now} ELSE published_at END,
                           updated_at = ${now}
                     WHERE id = ${id}
                       AND owner_id = ${ownerId}
                       AND ${sql.in("status", from)}
                  RETURNING *;`,
              );
              if (rows[0] === undefined) return Option.none();
              return Option.some(
                yield* decodeRow("ListingRepository.setStatus", ListingSchema, rows[0]),
              );
            }),
    } satisfies ListingRepository;
  }),
);
