import {
  LISTING_PHOTO_THUMBNAIL_LONG_EDGE,
  LISTING_PHOTO_THUMBNAIL_MAX_BYTES,
} from "@/db/schema/ListingPhoto";
import { PhotoThumbnailer, PhotoThumbnailerLive } from "@/services/photo-thumbnail.service";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

/*
 * The card-image codec, driven through the same Images-binding contract the
 * Worker provides. The binding itself is a platform service, so what is proved
 * here is this app's side of it: the transform it asks for, the ceiling it
 * enforces on the result, and that a codec failure becomes "no card image"
 * rather than a failed upload.
 */

const bytes = (length: number, fill = 7): Uint8Array => new Uint8Array(length).fill(fill);

interface FakeImages {
  readonly binding: ImagesBinding;
  readonly transforms: Array<ImageTransform>;
}

const imagesReturning = (output: () => Promise<Uint8Array>): FakeImages => {
  const transforms: Array<ImageTransform> = [];
  const transformer: ImageTransformer = {
    transform: (transform) => {
      transforms.push(transform);
      return transformer;
    },
    draw: () => transformer,
    output: async () => {
      const produced = await output();
      return {
        response: () => new Response(produced),
        contentType: () => "image/webp",
        image: () => new Response(produced).body as ReadableStream<Uint8Array>,
      };
    },
  };
  const binding = {
    input: () => transformer,
    info: async () => ({ format: "image/webp", fileSize: 0, width: 0, height: 0 }),
    hosted: {},
  } as unknown as ImagesBinding;
  return { binding, transforms };
};

const makeCard = (images: ImagesBinding, input: Uint8Array) =>
  Effect.gen(function* () {
    const thumbnailer = yield* PhotoThumbnailer;
    return yield* thumbnailer.makeCard(input);
  }).pipe(Effect.provide(PhotoThumbnailerLive(images)));

describe("the photo card image", () => {
  it.effect("asks for a WebP downscale capped on its long edge", () =>
    Effect.gen(function* () {
      const images = imagesReturning(async () => bytes(120));
      const card = yield* makeCard(images.binding, bytes(4096));

      assert.isTrue(Option.isSome(card));
      assert.strictEqual(Option.getOrThrow(card).length, 120);
      assert.deepStrictEqual(images.transforms, [
        {
          width: LISTING_PHOTO_THUMBNAIL_LONG_EDGE,
          height: LISTING_PHOTO_THUMBNAIL_LONG_EDGE,
          fit: "scale-down",
        },
      ]);
    }),
  );

  it.effect("refuses a card image over the stored ceiling", () =>
    Effect.gen(function* () {
      const images = imagesReturning(async () => bytes(LISTING_PHOTO_THUMBNAIL_MAX_BYTES + 1));
      const card = yield* makeCard(images.binding, bytes(4096));
      assert.isTrue(Option.isNone(card));
    }),
  );

  it.effect("answers a codec failure with no card image instead of failing", () =>
    Effect.gen(function* () {
      const images = imagesReturning(async () => {
        throw new Error("Undecodable image");
      });
      const card = yield* makeCard(images.binding, bytes(64));
      assert.isTrue(Option.isNone(card));
    }),
  );

  it.effect("never produces an empty card image", () =>
    Effect.gen(function* () {
      const images = imagesReturning(async () => bytes(0));
      const card = yield* makeCard(images.binding, bytes(4096));
      assert.isTrue(Option.isNone(card));
    }),
  );
});
