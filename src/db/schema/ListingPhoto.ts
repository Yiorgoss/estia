import { ListingId, ListingPhotoId } from "@/db/schema/brands";
import { Schema } from "effect";

/*
 * A listing's photo gallery. The bytes live in R2 under a server-generated key;
 * the row is the only place that key is known, and the public URL names the
 * listing and the photo instead. A caller never supplies a storage key, and
 * storage is never listed, so the gallery is the only way in and the only way
 * out.
 *
 * The limits are enforced by the service on the bytes it receives, not just by
 * the browser's `accept` attribute, and the same numbers are mirrored by the
 * database CHECK in `0007_listing_photos.sql`.
 */
export const LISTING_PHOTO_MAX_PER_LISTING = 10;
export const LISTING_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export const PhotoContentType = Schema.Literals(["image/jpeg", "image/png", "image/webp"]);
export type PhotoContentType = typeof PhotoContentType.Type;

export const PHOTO_CONTENT_TYPES: ReadonlyArray<PhotoContentType> = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

// The extension is derived from the validated type, never from the uploaded
// file name, so a caller cannot choose any part of the key.
const extensionFor: Record<PhotoContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const photoExtension = (contentType: PhotoContentType): string => extensionFor[contentType];

export const ListingPhotoSchema = Schema.Struct({
  id: ListingPhotoId,
  listingId: ListingId,
  storageKey: Schema.String,
  contentType: PhotoContentType,
  byteSize: Schema.Number,
  position: Schema.Number,
  createdAt: Schema.DateFromMillis,
});
export type ListingPhoto = typeof ListingPhotoSchema.Type;

/*
 * The URL a browser reads a photo from. It carries only the two ids the route
 * already needs; the storage key and the bucket name never reach the wire.
 */
export const listingPhotoUrl = (
  listingId: typeof ListingId.Type,
  photoId: typeof ListingPhotoId.Type,
): string => `/listings/${listingId}/photos/${photoId}`;

/*
 * The photo id in a path is not an id until it is a positive safe integer, so a
 * malformed segment is a 404 instead of reaching the database.
 */
export const decodeListingPhotoId = (
  raw: string | undefined,
): typeof ListingPhotoId.Type | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return Schema.decodeSync(ListingPhotoId)(id);
};
