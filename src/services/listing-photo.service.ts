import { ListingId, ListingPhotoId, UserId } from "@/db/schema/brands";
import {
  LISTING_PHOTO_MAX_BYTES,
  LISTING_PHOTO_MAX_PER_LISTING,
  ListingPhotoSchema,
  PhotoContentType,
  photoExtension,
} from "@/db/schema/ListingPhoto";
import { ListingPhotoRepository } from "@/repos/listing-photo.repo";
import { ListingRepository } from "@/repos/listing.repo";
import { R2DeleteError, R2UploadError, StorageRepository } from "@/repos/storage.repo";
import { ListingService } from "@/services/listing.service";
import type { ListingNotFoundError, ListingNotOwnedError } from "@/services/listing.service";
import { InternalError } from "@/services/user.service";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The gallery service owns every photo rule: who may write to a gallery, what
 * bytes may enter it, the ten-photo and five-megabyte limits, and the ordering
 * that puts exactly one photo first.
 *
 * The bytes are validated here, on the server, from the content the request
 * actually delivered. The declared multipart content type must be one of the
 * three allowed image types AND the leading bytes must match it, so a text file
 * labelled `image/png` never reaches storage. The storage key is generated here
 * from the listing id and a random uuid; no caller supplies any part of it.
 */

export class ListingPhotoValidationError extends Schema.TaggedError<ListingPhotoValidationError>()(
  "ListingPhotoValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class ListingPhotoNotFoundError extends Schema.TaggedError<ListingPhotoNotFoundError>()(
  "ListingPhotoNotFoundError",
  { listingId: ListingId, photoId: ListingPhotoId },
  { httpApiStatus: 404 },
) {}

export class ListingPhotoLimitError extends Schema.TaggedError<ListingPhotoLimitError>()(
  "ListingPhotoLimitError",
  { limit: Schema.Number },
  { httpApiStatus: 400 },
) {}

export interface PhotoUpload {
  readonly declaredContentType: string;
  readonly bytes: Uint8Array;
}

export type PhotoMove = "up" | "down";

// The listing-level failures every gallery operation can raise. They belong to
// `ListingService`; the gallery reuses them so a caller sees one shape.
export type ListingPhotoListingError = ListingNotFoundError | ListingNotOwnedError;

export interface ListingPhotoService {
  readonly listOwned: (
    ownerId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
  ) => Effect.Effect<
    ReadonlyArray<typeof ListingPhotoSchema.Type>,
    ListingPhotoListingError | InternalError
  >;

  readonly listPublic: (
    listingId: typeof ListingId.Type,
  ) => Effect.Effect<
    ReadonlyArray<typeof ListingPhotoSchema.Type>,
    ListingNotFoundError | InternalError
  >;

  /*
   * The first photo of each named listing, keyed by listing id, for the search
   * cards. One query for the whole page; a listing with no photos is absent.
   */
  readonly firstPhotos: (
    listingIds: ReadonlyArray<typeof ListingId.Type>,
  ) => Effect.Effect<ReadonlyMap<number, typeof ListingPhotoSchema.Type>, InternalError>;

  readonly add: (
    ownerId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
    upload: PhotoUpload,
  ) => Effect.Effect<
    typeof ListingPhotoSchema.Type,
    ListingPhotoListingError | ListingPhotoValidationError | ListingPhotoLimitError | InternalError
  >;

  readonly move: (
    ownerId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
    photoId: typeof ListingPhotoId.Type,
    direction: PhotoMove,
  ) => Effect.Effect<void, ListingPhotoListingError | ListingPhotoNotFoundError | InternalError>;

  readonly makeFirst: (
    ownerId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
    photoId: typeof ListingPhotoId.Type,
  ) => Effect.Effect<void, ListingPhotoListingError | ListingPhotoNotFoundError | InternalError>;

  readonly remove: (
    ownerId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
    photoId: typeof ListingPhotoId.Type,
  ) => Effect.Effect<void, ListingPhotoListingError | ListingPhotoNotFoundError | InternalError>;

  /*
   * Reads the bytes for one photo. A published listing's photos are public; a
   * draft or unlisted listing's photos are readable only by its owner. Anything
   * else is `None`, which every caller answers as the same 404.
   */
  readonly read: (
    listingId: typeof ListingId.Type,
    photoId: typeof ListingPhotoId.Type,
    viewerId: typeof UserId.Type | undefined,
  ) => Effect.Effect<
    Option.Option<{
      readonly photo: typeof ListingPhotoSchema.Type;
      readonly object: R2ObjectBody;
      readonly private: boolean;
    }>,
    InternalError
  >;
}

export const ListingPhotoService = Context.Service<ListingPhotoService>("ListingPhotoService");

const extensionOf = (contentType: PhotoContentType): string => photoExtension(contentType);

const normalizeContentType = (declared: string): PhotoContentType | undefined => {
  const mediaType = declared.toLowerCase().split(";")[0]?.trim() ?? "";
  return mediaType === "image/jpeg" || mediaType === "image/png" || mediaType === "image/webp"
    ? mediaType
    : undefined;
};

const startsWithBytes = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

/*
 * The magic-byte check. A declared content type is a claim; this is the file
 * itself. Only the three formats the gallery accepts have a signature here.
 */
const sniffContentType = (bytes: Uint8Array): PhotoContentType | undefined => {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // RIFF....WEBP
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return undefined;
};

// Services collapse driver failures into `InternalError` and log the real cause.
const fromSql = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, InternalError> =>
  effect.pipe(
    Effect.catchTag("SqlError", (error) =>
      Effect.logError("Listing photo operation failed", { error }).pipe(
        Effect.andThen(Effect.fail(new InternalError())),
      ),
    ),
  );

const fromStorage = <A>(
  effect: Effect.Effect<A, R2UploadError | R2DeleteError>,
): Effect.Effect<A, InternalError> =>
  effect.pipe(
    Effect.catchTags({
      R2UploadError: (error) =>
        Effect.logError("Photo upload failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        ),
      R2DeleteError: (error) =>
        Effect.logError("Photo delete failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        ),
    }),
  );

export const ListingPhotoServiceLive = Layer.effect(
  ListingPhotoService,
  Effect.gen(function* () {
    const listingService = yield* ListingService;
    const listingRepo = yield* ListingRepository;
    const photoRepo = yield* ListingPhotoRepository;
    const storage = yield* StorageRepository;

    const loadOwned = (ownerId: typeof UserId.Type, listingId: typeof ListingId.Type) =>
      listingService.getOwn(ownerId, listingId);

    const ordered = (listingId: typeof ListingId.Type) =>
      fromSql(photoRepo.listByListing(listingId));

    const requirePhoto = (listingId: typeof ListingId.Type, photoId: typeof ListingPhotoId.Type) =>
      Effect.gen(function* () {
        const found = yield* fromSql(photoRepo.findById(listingId, photoId));
        return yield* Option.match(found, {
          onNone: () => Effect.fail(new ListingPhotoNotFoundError({ listingId, photoId })),
          onSome: Effect.succeed,
        });
      });

    const reorderTo = (
      listingId: typeof ListingId.Type,
      photos: ReadonlyArray<typeof ListingPhotoSchema.Type>,
    ) =>
      fromSql(
        photoRepo.reorder(
          listingId,
          photos.map((photo) => photo.id),
        ),
      );

    return {
      listOwned: (ownerId, listingId) =>
        Effect.gen(function* () {
          yield* loadOwned(ownerId, listingId);
          return yield* ordered(listingId);
        }),
      listPublic: (listingId) =>
        Effect.gen(function* () {
          yield* listingService.getPublic(listingId);
          return yield* ordered(listingId);
        }),
      firstPhotos: (listingIds) =>
        fromSql(photoRepo.firstForListings(listingIds)).pipe(
          Effect.map(
            (photos) => new Map(photos.map((photo) => [Number(photo.listingId), photo] as const)),
          ),
        ),
      add: (ownerId, listingId, upload) =>
        Effect.gen(function* () {
          yield* loadOwned(ownerId, listingId);

          const declared = normalizeContentType(upload.declaredContentType);
          if (declared === undefined) {
            return yield* Effect.fail(
              new ListingPhotoValidationError({
                message: "Photos must be JPEG, PNG, or WebP images.",
              }),
            );
          }
          if (upload.bytes.length === 0) {
            return yield* Effect.fail(
              new ListingPhotoValidationError({ message: "That photo is empty." }),
            );
          }
          if (upload.bytes.length > LISTING_PHOTO_MAX_BYTES) {
            return yield* Effect.fail(
              new ListingPhotoValidationError({
                message: "Each photo must be 5 MB or smaller.",
              }),
            );
          }
          const sniffed = sniffContentType(upload.bytes);
          if (sniffed === undefined || sniffed !== declared) {
            return yield* Effect.fail(
              new ListingPhotoValidationError({
                message: "That file does not look like the image type it claims to be.",
              }),
            );
          }

          const count = yield* fromSql(photoRepo.countByListing(listingId));
          if (count >= LISTING_PHOTO_MAX_PER_LISTING) {
            return yield* Effect.fail(
              new ListingPhotoLimitError({ limit: LISTING_PHOTO_MAX_PER_LISTING }),
            );
          }

          const key = `listings/${listingId}/photos/${crypto.randomUUID()}.${extensionOf(sniffed)}`;
          yield* fromStorage(storage.put(key, upload.bytes));

          return yield* fromSql(
            photoRepo.insert(listingId, {
              storageKey: key,
              contentType: sniffed,
              byteSize: upload.bytes.length,
              position: count,
            }),
          ).pipe(
            // The row is what makes the object reachable, so a failed insert
            // removes the orphan rather than leaving bytes no row can name.
            Effect.tapError(() => storage.delete(key).pipe(Effect.ignore)),
          );
        }),
      move: (ownerId, listingId, photoId, direction) =>
        Effect.gen(function* () {
          yield* loadOwned(ownerId, listingId);
          yield* requirePhoto(listingId, photoId);
          const photos = yield* ordered(listingId);
          const index = photos.findIndex((photo) => photo.id === photoId);
          const target = direction === "up" ? index - 1 : index + 1;
          if (target < 0 || target >= photos.length) return;
          const next = [...photos];
          const moved = next[index];
          const displaced = next[target];
          if (moved === undefined || displaced === undefined) return;
          next[index] = displaced;
          next[target] = moved;
          yield* reorderTo(listingId, next);
        }),
      makeFirst: (ownerId, listingId, photoId) =>
        Effect.gen(function* () {
          yield* loadOwned(ownerId, listingId);
          yield* requirePhoto(listingId, photoId);
          const photos = yield* ordered(listingId);
          const photo = photos.find((candidate) => candidate.id === photoId);
          if (photo === undefined) return;
          yield* reorderTo(listingId, [photo, ...photos.filter((other) => other.id !== photoId)]);
        }),
      remove: (ownerId, listingId, photoId) =>
        Effect.gen(function* () {
          yield* loadOwned(ownerId, listingId);
          const photo = yield* requirePhoto(listingId, photoId);
          const deleted = yield* fromSql(photoRepo.deleteById(listingId, photoId));
          if (Option.isNone(deleted)) {
            return yield* Effect.fail(new ListingPhotoNotFoundError({ listingId, photoId }));
          }
          // Close the gap the deleted position left, so positions stay 0..n-1.
          const remaining = yield* ordered(listingId);
          yield* reorderTo(listingId, remaining);
          // The row is gone, so no route can name these bytes any more. A
          // failed delete leaves an unreachable orphan, which is logged rather
          // than turned into a failed request the owner cannot act on.
          yield* storage
            .delete(photo.storageKey)
            .pipe(
              Effect.catchTag("R2DeleteError", (error) =>
                Effect.logError("Deleted photo left an unreachable object", { error }),
              ),
            );
        }),
      read: (listingId, photoId, viewerId) =>
        Effect.gen(function* () {
          const foundListing = yield* fromSql(listingRepo.findById(listingId));
          if (Option.isNone(foundListing)) return Option.none();
          const listing = foundListing.value;
          if (listing.status !== "published" && listing.ownerId !== viewerId) {
            return Option.none();
          }

          const foundPhoto = yield* fromSql(photoRepo.findById(listingId, photoId));
          if (Option.isNone(foundPhoto)) return Option.none();
          const photo = foundPhoto.value;

          const object = yield* storage
            .get(photo.storageKey, undefined)
            .pipe(
              Effect.catchTag("R2ReadError", (error) =>
                Effect.logError("Photo read failed", { error }).pipe(
                  Effect.andThen(Effect.fail(new InternalError())),
                ),
              ),
            );
          return Option.map(object, (body) => ({
            photo,
            object: body,
            private: listing.status !== "published",
          }));
        }),
    } satisfies ListingPhotoService;
  }),
);
