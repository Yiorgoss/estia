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

  readonly countByListing: (listingId: typeof ListingId.Type) => Effect.Effect<number, SqlError>;

  readonly insert: (
    listingId: typeof ListingId.Type,
    values: {
      readonly storageKey: string;
      readonly contentType: PhotoContentType;
      readonly byteSize: number;
      readonly position: number;
    },
  ) => Effect.Effect<typeof ListingPhotoSchema.Type, SqlError>;

  readonly deleteById: (
    listingId: typeof ListingId.Type,
    photoId: typeof ListingPhotoId.Type,
  ) => Effect.Effect<Option.Option<typeof ListingPhotoSchema.Type>, SqlError>;

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
   * The first photo of each named listing, in one query. A listing with no
   * photos is simply absent from the result, which is the search card's
   * placeholder case.
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

const decodeSingle = (
  rows: ReadonlyArray<Record<string, unknown>>,
): typeof ListingPhotoSchema.Type => decodePhoto(Option.getOrThrow(Option.fromNullishOr(rows[0])));

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
      countByListing: (listingId) =>
        sql<{ readonly total: number }>`
            SELECT COUNT(*) AS total
              FROM listing_photos
             WHERE listing_id = ${listingId}
            `.pipe(Effect.map((rows) => rows[0]?.total ?? 0)),
      insert: (listingId, values) =>
        sql<Record<string, unknown>>`
              INSERT INTO listing_photos (listing_id, storage_key, content_type, byte_size, position)
              VALUES (${listingId}, ${values.storageKey}, ${values.contentType}, ${values.byteSize}, ${values.position})
              RETURNING *;
            `.pipe(Effect.map(decodeSingle)),
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
      firstForListings: (listingIds) =>
        listingIds.length === 0
          ? Effect.succeed([])
          : sql<Record<string, unknown>>`
                SELECT *
                  FROM listing_photos
                 WHERE position = 0
                   AND ${sql.in("listing_id", listingIds)}
              ORDER BY listing_id ASC
                `.pipe(Effect.map(decodePhotos)),
    } satisfies ListingPhotoRepository;
  }).pipe(
    Effect.tapError((error) => Effect.logError("Listing photo repository failed", { error })),
  ),
);
