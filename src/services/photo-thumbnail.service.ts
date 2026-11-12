import {
  LISTING_PHOTO_THUMBNAIL_LONG_EDGE,
  LISTING_PHOTO_THUMBNAIL_MAX_BYTES,
  LISTING_PHOTO_THUMBNAIL_QUALITY,
} from "@/db/schema/ListingPhoto";
import { Context, Effect, Layer, Option, Schema } from "effect";

/*
 * The one downscaled card image a photo has. It is produced at upload time from
 * the bytes the service already validated, so a search card or a preview grid
 * never transfers the original.
 *
 * The encoder is the Worker's Images binding: the same code runs in production
 * and in the local dev server, and no image codec is bundled into the app. Long
 * edges are capped at `LISTING_PHOTO_THUMBNAIL_LONG_EDGE` and the produced bytes
 * at `LISTING_PHOTO_THUMBNAIL_MAX_BYTES`, so a hostile input cannot make the
 * stored card image large.
 *
 * A photo the codec cannot read, or whose card image would exceed the ceiling,
 * yields `None` instead of failing: the upload keeps the original, records a
 * null thumbnail key, and the card serves the original.
 */
export interface PhotoThumbnailer {
  readonly makeCard: (bytes: Uint8Array) => Effect.Effect<Option.Option<Uint8Array>>;
}

export const PhotoThumbnailer = Context.Service<PhotoThumbnailer>("PhotoThumbnailer");

class PhotoThumbnailError extends Schema.TaggedError<PhotoThumbnailError>()("PhotoThumbnailError", {
  cause: Schema.Unknown,
}) {}

const makeCard = async (images: ImagesBinding, bytes: Uint8Array): Promise<Uint8Array> => {
  const output = await images
    .input(new Blob([bytes]).stream())
    .transform({
      width: LISTING_PHOTO_THUMBNAIL_LONG_EDGE,
      height: LISTING_PHOTO_THUMBNAIL_LONG_EDGE,
      fit: "scale-down",
    })
    .output({ format: "image/webp", quality: LISTING_PHOTO_THUMBNAIL_QUALITY });
  return new Uint8Array(await output.response().arrayBuffer());
};

export const PhotoThumbnailerLive = (images: ImagesBinding): Layer.Layer<PhotoThumbnailer> =>
  Layer.succeed(PhotoThumbnailer, {
    makeCard: (bytes) =>
      Effect.tryPromise({
        try: () => makeCard(images, bytes),
        catch: (cause) => new PhotoThumbnailError({ cause }),
      }).pipe(
        Effect.map((thumbnail) =>
          thumbnail.byteLength > 0 && thumbnail.byteLength <= LISTING_PHOTO_THUMBNAIL_MAX_BYTES
            ? Option.some(thumbnail)
            : Option.none(),
        ),
        Effect.catchTag("PhotoThumbnailError", (error) =>
          Effect.logWarning("Photo card image could not be produced", { error }).pipe(
            Effect.andThen(Effect.succeed(Option.none<Uint8Array>())),
          ),
        ),
      ),
  });
