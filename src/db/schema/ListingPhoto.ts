import { ListingId, ListingPhotoId } from "@/db/schema/brands";
import { Schema } from "effect";

/*
 * A listing's photo gallery. The bytes live in R2 under a server-generated key;
 * the row is the only place that key is known, and the public URL names the
 * listing and the photo instead. A caller never supplies a storage key, and
 * storage is never listed, so the gallery is the only way in and the only way
 * out.
 *
 * The byte limit and the accepted content types are enforced by the service on
 * the bytes it receives, not just by the browser's `accept` attribute, and
 * mirrored by the database CHECK in `0009_listing_photos.sql`. The ten-photo
 * cap has no CHECK because it counts siblings, so the gallery's insert
 * statement decides it.
 *
 * A photo also has one downscaled card image, produced at upload time from the
 * same validated bytes. `thumbnail_key` (added by
 * `0010_listing_photo_thumbnails.sql`) is the only record of it: when it is
 * null no downscaled copy exists and the card image is the original, so a codec
 * failure never loses a photo and an owner can see which photos lack a copy.
 */
export const LISTING_PHOTO_MAX_PER_LISTING = 10;
export const LISTING_PHOTO_MAX_BYTES = 1 * 1024 * 1024;
export const LISTING_PHOTO_THUMBNAIL_LONG_EDGE = 640;
export const LISTING_PHOTO_THUMBNAIL_QUALITY = 80;
export const LISTING_PHOTO_THUMBNAIL_MAX_BYTES = 256 * 1024;

export const PhotoContentType = Schema.Literals(["image/jpeg", "image/png", "image/webp"]);
export type PhotoContentType = typeof PhotoContentType.Type;

// Card images are always WebP, the format the encoder emits, so the type is a
// constant here rather than another column the card read would have to trust.
export const LISTING_PHOTO_THUMBNAIL_CONTENT_TYPE: PhotoContentType = "image/webp";

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
  thumbnailKey: Schema.NullOr(Schema.String),
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
 * The card image: the downscaled copy when the row has one, the original when
 * it does not. Cards and preview grids read this URL; the detail page reads
 * `listingPhotoUrl`, so the two never swap bytes.
 */
export const listingPhotoCardUrl = (
  listingId: typeof ListingId.Type,
  photoId: typeof ListingPhotoId.Type,
): string => `${listingPhotoUrl(listingId, photoId)}/card`;

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
