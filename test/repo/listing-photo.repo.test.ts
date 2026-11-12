import { ListingId, ListingPhotoId } from "@/db/schema/brands";
import { ListingPhotoRepository, ListingPhotoRepositoryLive } from "@/repos/listing-photo.repo";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { insertListing, insertListingPhoto, insertUser } from "../support/seed";
import { TestSqlLive } from "../support/sql";

const listingId = (value: number) => Schema.decodeSync(ListingId)(value);
const photoId = (value: number) => Schema.decodeSync(ListingPhotoId)(value);

const TestLive = Layer.merge(
  ListingPhotoRepositoryLive.pipe(Layer.provide(TestSqlLive)),
  TestSqlLive,
);

const seedListing = (id: number, owner: string) =>
  Effect.gen(function* () {
    yield* insertUser(owner, `${owner}@test.local`);
    yield* insertListing(id, owner);
  });

layer(TestLive, { concurrent: false })("ListingPhotoRepository", (it) => {
  it.effect("appends photos in order and refuses to exceed the cap", () =>
    Effect.gen(function* () {
      yield* seedListing(701, "u-photo-repo-701");
      const repo = yield* ListingPhotoRepository;

      const first = yield* repo.append(
        listingId(701),
        {
          storageKey: "listings/701/photos/a.jpg",
          contentType: "image/jpeg",
          byteSize: 10,
          thumbnailKey: "listings/701/photos/a-card.webp",
        },
        2,
      );
      const second = yield* repo.append(
        listingId(701),
        {
          storageKey: "listings/701/photos/b.png",
          contentType: "image/png",
          byteSize: 20,
          thumbnailKey: null,
        },
        2,
      );

      assert.isTrue(Option.isSome(first));
      assert.isTrue(Option.isSome(second));
      const firstPhoto = Option.getOrThrow(first);
      const secondPhoto = Option.getOrThrow(second);
      assert.strictEqual(firstPhoto.position, 0);
      assert.strictEqual(secondPhoto.position, 1);
      assert.strictEqual(secondPhoto.contentType, "image/png");

      const full = yield* repo.append(
        listingId(701),
        {
          storageKey: "listings/701/photos/c.jpg",
          contentType: "image/jpeg",
          byteSize: 30,
          thumbnailKey: null,
        },
        2,
      );
      assert.isTrue(Option.isNone(full));

      const listed = yield* repo.listByListing(listingId(701));
      assert.deepStrictEqual(
        listed.map((photo) => photo.id),
        [firstPhoto.id, secondPhoto.id],
      );

      const found = yield* repo.findById(listingId(701), secondPhoto.id);
      assert.isTrue(Option.isSome(found));
      assert.strictEqual(Option.getOrThrow(found).storageKey, "listings/701/photos/b.png");
      // The thumbnail key is the row's record that a downscaled card image
      // exists; null means the card falls back to the original.
      assert.strictEqual(
        Option.getOrThrow(yield* repo.findById(listingId(701), firstPhoto.id)).thumbnailKey,
        "listings/701/photos/a-card.webp",
      );
      assert.isNull(Option.getOrThrow(found).thumbnailKey);
    }),
  );

  it.effect("scopes reads and deletes by listing, so another listing's photo is invisible", () =>
    Effect.gen(function* () {
      yield* seedListing(702, "u-photo-repo-702");
      yield* seedListing(703, "u-photo-repo-703");
      yield* insertListingPhoto(7201, 702);
      yield* insertListingPhoto(7202, 702);
      yield* insertListingPhoto(7301, 703);

      const repo = yield* ListingPhotoRepository;
      assert.isTrue(Option.isNone(yield* repo.findById(listingId(703), photoId(7201))));

      // A delete scoped to the wrong listing removes nothing.
      const missed = yield* repo.deleteById(listingId(703), photoId(7201));
      assert.isTrue(Option.isNone(missed));
      assert.lengthOf(yield* repo.listByListing(listingId(702)), 2);

      const removed = yield* repo.deleteById(listingId(702), photoId(7201));
      assert.isTrue(Option.isSome(removed));
      assert.strictEqual(Option.getOrThrow(removed).id, 7201);
      assert.lengthOf(yield* repo.listByListing(listingId(702)), 1);
    }),
  );

  it.effect("reorder writes the whole gallery order in one statement", () =>
    Effect.gen(function* () {
      yield* seedListing(704, "u-photo-repo-704");
      yield* insertListingPhoto(7401, 704, { position: 0 });
      yield* insertListingPhoto(7402, 704, { position: 1 });
      yield* insertListingPhoto(7403, 704, { position: 2 });

      const repo = yield* ListingPhotoRepository;
      yield* repo.reorder(listingId(704), [photoId(7403), photoId(7401), photoId(7402)]);

      const listed = yield* repo.listByListing(listingId(704));
      assert.deepStrictEqual(
        listed.map((photo) => [photo.id, photo.position]),
        [
          [7403, 0],
          [7401, 1],
          [7402, 2],
        ],
      );
    }),
  );

  it.effect("compacts positions from the order the gallery holds", () =>
    Effect.gen(function* () {
      yield* seedListing(709, "u-photo-repo-709");
      yield* insertListingPhoto(7901, 709, { position: 4 });
      yield* insertListingPhoto(7902, 709, { position: 2 });
      yield* insertListingPhoto(7903, 709, { position: 9 });

      const repo = yield* ListingPhotoRepository;
      yield* repo.compactPositions(listingId(709));

      const listed = yield* repo.listByListing(listingId(709));
      assert.deepStrictEqual(
        listed.map((photo) => [photo.id, photo.position]),
        [
          [7902, 0],
          [7901, 1],
          [7903, 2],
        ],
      );
    }),
  );

  it.effect(
    "firstForListings returns one first photo per listing, and none for a photo-less one",
    () =>
      Effect.gen(function* () {
        yield* seedListing(705, "u-photo-repo-705");
        yield* seedListing(706, "u-photo-repo-706");
        yield* seedListing(707, "u-photo-repo-707");
        yield* seedListing(710, "u-photo-repo-710");
        yield* insertListingPhoto(7501, 705, { position: 0 });
        yield* insertListingPhoto(7502, 705, { position: 1 });
        yield* insertListingPhoto(7601, 706, { position: 0 });
        // Drifted positions must not hide a gallery from the search cards: the
        // first photo is the one the gallery order puts first.
        yield* insertListingPhoto(7701, 707, { position: 3 });
        yield* insertListingPhoto(7702, 707, { position: 1 });

        const repo = yield* ListingPhotoRepository;
        const first = yield* repo.firstForListings([
          listingId(705),
          listingId(706),
          listingId(707),
          listingId(710),
        ]);

        assert.deepStrictEqual(
          first.map((photo) => [Number(photo.listingId), photo.id]),
          [
            [705, 7501],
            [706, 7601],
            [707, 7702],
          ],
        );
        assert.deepStrictEqual(yield* repo.firstForListings([]), []);
      }),
  );

  it.effect("the database refuses an unsupported type and an oversized photo", () =>
    Effect.gen(function* () {
      yield* seedListing(708, "u-photo-repo-708");

      const badType = yield* Effect.flip(
        insertListingPhoto(7801, 708, { contentType: "image/gif" as "image/png" }),
      );
      assert.strictEqual(badType._tag, "SqlError");

      const tooBig = yield* Effect.flip(insertListingPhoto(7802, 708, { byteSize: 5_242_881 }));
      assert.strictEqual(tooBig._tag, "SqlError");
    }),
  );
});
