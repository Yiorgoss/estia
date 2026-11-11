import { ListingsGroup } from "@/api/public";
import { ListingId, UserId } from "@/db/schema/brands";
import { ListingCursor, ListingPage } from "@/db/schema/Listing";
import { ListingHandler } from "@/handlers/public/listing.handler";
import { ListingPhotoService } from "@/services/listing-photo.service";
import { ListingService } from "@/services/listing.service";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";

// The same API id and group the public router uses, so the real endpoint,
// handler, and success schema are what the request runs through.
const TestApi = HttpApi.make("public").add(ListingsGroup).prefix("/api");

const publicKeys = [
  "availableFrom",
  "currency",
  "description",
  "ensuite",
  "furnished",
  "id",
  "kind",
  "pets",
  "photos",
  "priceMinor",
  "publishedAt",
  "regionCode",
  "sizeSqm",
  "smoking",
  "thumbnailUrl",
  "title",
];

const publishedListing = {
  id: Schema.decodeSync(ListingId)(7),
  kind: "room" as const,
  ownerId: Schema.decodeSync(UserId)("u-public-owner"),
  status: "published" as const,
  title: "Seaside studio",
  description: "Steps from the beach",
  priceMinor: 120_000,
  currency: "EUR" as const,
  regionCode: "crete" as const,
  lat: 35.24,
  lng: 25.72,
  sizeSqm: 42,
  availableFrom: new Date("2026-03-01T00:00:00.000Z"),
  furnished: true,
  ensuite: false,
  smoking: false,
  pets: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  publishedAt: new Date("2026-01-03T00:00:00.000Z"),
};

const page: typeof ListingPage.Type = {
  items: [publishedListing],
  nextCursor: Schema.decodeSync(ListingCursor)({ createdAt: 1_700_000_000_000, id: 7 }),
};

const service = (result: typeof ListingPage.Type): ListingService => ({
  createDraft: () => Effect.die("not used"),
  updateListing: () => Effect.die("not used"),
  publish: () => Effect.die("not used"),
  unlist: () => Effect.die("not used"),
  getOwn: () => Effect.die("not used"),
  getPublic: () => Effect.die("not used"),
  listMine: () => Effect.die("not used"),
  search: () => Effect.succeed(result),
  mapPins: () => Effect.die("not used"),
});

const photoService: ListingPhotoService = {
  listOwned: () => Effect.die("not used"),
  listPublic: () => Effect.die("not used"),
  firstPhotos: () => Effect.succeed(new Map()),
  add: () => Effect.die("not used"),
  move: () => Effect.die("not used"),
  makeFirst: () => Effect.die("not used"),
  remove: () => Effect.die("not used"),
  read: () => Effect.die("not used"),
};

type PublicBody = {
  items: ReadonlyArray<Record<string, unknown>>;
  nextCursor: string | null;
};

const search = (result: typeof ListingPage.Type) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(TestApi).pipe(
          Layer.provide(ListingHandler),
          HttpRouter.provideRequest(Layer.succeed(ListingService, service(result))),
          HttpRouter.provideRequest(Layer.succeed(ListingPhotoService, photoService)),
          Layer.provide(Etag.layer),
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Path.layer),
          Layer.provide(FileSystem.layerNoop({})),
        ),
        { disableLogger: true },
      ),
    ),
    ({ handler }) =>
      Effect.promise(async () => {
        const response = await (handler as unknown as (request: Request) => Promise<Response>)(
          new Request("http://localhost/api/listings/"),
        );
        return { status: response.status, body: (await response.json()) as PublicBody };
      }),
    ({ dispose }) => Effect.promise(dispose),
  );

describe("GET /api/listings", () => {
  it.effect("serves only the public fields, never the owner, coordinates, or lifecycle", () =>
    Effect.gen(function* () {
      const { status, body } = yield* search(page);

      assert.strictEqual(status, 200);
      assert.lengthOf(body.items, 1);
      assert.deepStrictEqual(Object.keys(body.items[0]).sort(), publicKeys);
      assert.strictEqual(body.items[0].id, publishedListing.id);
      assert.strictEqual(body.items[0].title, publishedListing.title);
      assert.isString(body.nextCursor);
      assert.notInclude(body.nextCursor, ":");
    }),
  );
});
