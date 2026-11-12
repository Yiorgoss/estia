import { ListingId, ListingPhotoId } from "@/db/schema/brands";
import { ListingPhotoSchema, PhotoContentType } from "@/db/schema/ListingPhoto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The listing photo repository. Every statement is scoped by `listing_id`, so a
 * photo id from another listing cannot be read, reordered, or deleted through
 * the wrong gallery. Like the listings repository it is single-statement only:
 * D1 has no interactive transaction through this driver.
 */
export interface ListingPhotoRepository {
  readonly listByListing: (
    listingId: typeof ListingId.Type,
  ) => Effect.Effect<ReadonlyArray<typeof ListingPhotoSchema.Type>, SqlError>;

  readonly findById: (
    listingId: typeof ListingId.Type,
    photoId: typeof ListingPhotoId.Type,
  ) => Effect.Effect<Option.Option<typeof ListingPhotoSchema.Type>, SqlError>;

  /*
   * Appends one photo at the end of the gallery and decides the ten-photo cap
   * in the same statement, so the count read cannot go stale between the check
   * and the write. `None` means the gallery was already full.
   */
  readonly append: (
    listingId: typeof ListingId.Type,
    values: {
      readonly storageKey: string;
      readonly contentType: PhotoContentType;
      readonly byteSize: number;
      readonly thumbnailKey: string | null;
    },
    limit: number,
  ) => Effect.Effect<Option.Option<typeof ListingPhotoSchema.Type>, SqlError>;

  readonly deleteById: (
    listingId: typeof ListingId.Type,
    photoId: typeof ListingPhotoId.Type,
  ) => Effect.Effect<Option.Option<typeof ListingPhotoSchema.Type>, SqlError>;

  /*
   * Rewrites a gallery's positions as 0..n-1 from the order the table holds,
   * in one statement, so closing a gap left by a delete never depends on an
   * order the caller read earlier.
   */
  readonly compactPositions: (listingId: typeof ListingId.Type) => Effect.Effect<void, SqlError>;

  /*
   * Writes a whole gallery order in one statement. The ids must be this
   * listing's photos; ids outside the list keep their stored position, and the
   * caller always passes the complete set.
   */
  readonly reorder: (
    listingId: typeof ListingId.Type,
    orderedIds: ReadonlyArray<typeof ListingPhotoId.Type>,
  ) => Effect.Effect<void, SqlError>;

  /*
   * The first photo of each named listing, in one query: the row the gallery
   * order puts first, which is the same row `listByListing` returns first. A
   * listing with no photos is simply absent from the result, which is the
   * search card's placeholder case.
   */
  readonly firstForListings: (
    listingIds: ReadonlyArray<typeof ListingId.Type>,
  ) => Effect.Effect<ReadonlyArray<typeof ListingPhotoSchema.Type>, SqlError>;
}

export const ListingPhotoRepository =
  Context.Service<ListingPhotoRepository>("ListingPhotoRepository");

const decodePhoto = (row: Record<string, unknown>): typeof ListingPhotoSchema.Type =>
  Schema.decodeUnknownSync(ListingPhotoSchema)(row);

const decodePhotos = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<typeof ListingPhotoSchema.Type> => rows.map(decodePhoto);

export const ListingPhotoRepositoryLive = Layer.effect(
  ListingPhotoRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      listByListing: (listingId) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM listing_photos
             WHERE listing_id = ${listingId}
          ORDER BY position ASC, id ASC
            `.pipe(Effect.map(decodePhotos)),
      findById: (listingId, photoId) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM listing_photos
             WHERE listing_id = ${listingId}
               AND id = ${photoId}
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodePhoto)),
        ),
      append: (listingId, values, limit) =>
        sql<Record<string, unknown>>`
              INSERT INTO listing_photos (listing_id, storage_key, content_type, byte_size, thumbnail_key, position)
              SELECT ${listingId}, ${values.storageKey}, ${values.contentType}, ${values.byteSize}, ${values.thumbnailKey},
                     (SELECT COUNT(*) FROM listing_photos WHERE listing_id = ${listingId})
               WHERE (SELECT COUNT(*) FROM listing_photos WHERE listing_id = ${listingId}) < ${limit}
              RETURNING *;
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodePhoto)),
        ),
      deleteById: (listingId, photoId) =>
        sql<Record<string, unknown>>`
              DELETE FROM listing_photos
               WHERE listing_id = ${listingId}
                 AND id = ${photoId}
              RETURNING *;
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodePhoto)),
        ),
      reorder: (listingId, orderedIds) =>
        orderedIds.length === 0
          ? Effect.void
          : Effect.asVoid(
              sql`
                UPDATE listing_photos
                   SET position = CASE id
                     ${sql.join(
                       " ",
                       false,
                     )(orderedIds.map((id, index) => sql`WHEN ${id} THEN ${index}`))}
                     ELSE position
                   END
                 WHERE listing_id = ${listingId}
                   AND ${sql.in("id", orderedIds)};
              `,
            ),
      compactPositions: (listingId) =>
        Effect.asVoid(
          sql`
            UPDATE listing_photos
               SET position = ranked.position
              FROM (
                SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) - 1 AS position
                  FROM listing_photos
                 WHERE listing_id = ${listingId}
              ) AS ranked
             WHERE listing_photos.id = ranked.id
               AND listing_photos.listing_id = ${listingId};
          `,
        ),
      firstForListings: (listingIds) =>
        listingIds.length === 0
          ? Effect.succeed([])
          : sql<Record<string, unknown>>`
                SELECT *
                  FROM listing_photos
                 WHERE ${sql.in("listing_id", listingIds)}
                   AND id = (
                     SELECT first_photo.id
                       FROM listing_photos AS first_photo
                      WHERE first_photo.listing_id = listing_photos.listing_id
                   ORDER BY first_photo.position ASC, first_photo.id ASC
                      LIMIT 1
                   )
              ORDER BY listing_id ASC
                `.pipe(Effect.map(decodePhotos)),
    } satisfies ListingPhotoRepository;
  }).pipe(
    Effect.tapError((error) => Effect.logError("Listing photo repository failed", { error })),
  ),
);
