import {
  PublicApi,
  toPublicListing,
  toPublicListingPage,
  toPublicListingPinPage,
} from "@/api/public";
import { ListingService } from "@/services/listing.service";
import { ListingPhotoService } from "@/services/listing-photo.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

/*
 * The unauthenticated listing reads: the search feed and one listing. Both map
 * the row through the public projection in `@/api/public` before it leaves, and
 * neither carries an identity: `getPublic` owns the published-only rule and
 * answers the same 404 for a draft, an unlisted listing, and an unknown id.
 */
export const ListingHandler = HttpApiBuilder.group(PublicApi, "listings", (handlers) =>
  handlers
    .handle("search", ({ query }) =>
      Effect.gen(function* () {
        const listingService = yield* ListingService;
        // The query schema decodes the wire form into the model's own filters
        // and page request; the service owns the visibility, ordering, and limit
        // rules, so the handler only splits them apart.
        const { limit, cursor, ...filters } = query;
        const page = yield* listingService.search(filters, { limit, cursor });
        const photoService = yield* ListingPhotoService;
        const firstPhotos = yield* photoService.firstPhotos(page.items.map((item) => item.id));
        return toPublicListingPage(page, firstPhotos);
      }),
    )
    .handle("map", ({ query }) =>
      Effect.gen(function* () {
        const listingService = yield* ListingService;
        // The filters are the feed's own vocabulary; `limit` bounds the pins
        // instead of paging them. The projection rounds every coordinate, so
        // the handler never sees - let alone returns - a raw pair.
        const { limit, ...filters } = query;
        const rows = yield* listingService.mapPins(filters, limit);
        return toPublicListingPinPage(rows);
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const listingService = yield* ListingService;
        const photoService = yield* ListingPhotoService;
        const listing = yield* listingService.getPublic(params.id);
        const photos = yield* photoService.listPublic(params.id);
        return toPublicListing(listing, photos);
      }),
    ),
);
