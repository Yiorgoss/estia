import { UserCredentials } from "@/db/schema/User";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Effect, Option, Schema } from "effect";
import { InvalidCredentialsError, UnauthorizedError } from "@/services/auth.service";
import { InternalError, UserAlreadyExistsError } from "@/services/user.service";
import { loginPage, registerPage } from "@/frontend/pages/auth";
import { AuthPageRoutes } from "@/handlers/public/auth-pages";
import { SessionRoutes } from "@/handlers/public/session";
import { mapPage, mapUnavailablePage } from "@/frontend/pages/map";
import { MapBasemapUrl, MapTilesRoute } from "@/api/map-tiles";
import { searchPage } from "@/frontend/pages/search";
import { searchResults, searchResultsError } from "@/frontend/search-results";
import { JWTSchema, ListingId, ListingPhotoId, RefreshTokenValue } from "@/db/schema/brands";
import {
  decodeListingId,
  LISTING_MAP_DEFAULT_LIMIT,
  ListingCursorFromString,
  ListingMapQuery,
  ListingPage,
  ListingSchema,
  ListingSearchQuery,
  ListingSearchQueryCodec,
} from "@/db/schema/Listing";
import { approximateLocation, ListingPinPage } from "@/db/schema/ListingPin";
import { ListingNotFoundError, ListingService } from "@/services/listing.service";
import { listingPhotoUrl, decodeListingPhotoId } from "@/db/schema/ListingPhoto";
import type { ListingPhoto } from "@/db/schema/ListingPhoto";
import { ListingPhotoService } from "@/services/listing-photo.service";
import { callerId } from "@/handlers/private/caller";
import {
  listingDetailPage,
  listingNotFoundPage,
  listingUnavailablePage,
} from "@/frontend/pages/listing-detail";
import { withMinorUnitPrices } from "@/utils";

const AuthGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("login", "/login", {
      payload: UserCredentials,
      success: Schema.Struct({
        accessToken: JWTSchema,
        refreshToken: RefreshTokenValue,
      }),
      error: [InvalidCredentialsError, UnauthorizedError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("register", "/register", {
      payload: UserCredentials,
      success: Schema.Struct({
        accessToken: JWTSchema,
        refreshToken: RefreshTokenValue,
      }),
      // A duplicate email is a client mistake with an action attached - sign in
      // instead, or use another address - so it is a 409, not a server error.
      error: [UserAlreadyExistsError, InternalError],
    }),
  )
  // A group prefix only applies to the endpoints added before it.
  .prefix("/auth");

/*
 * The feed and the single-listing endpoint are unauthenticated, so their wire
 * shape is a projection of the listing row, not the row itself: the owner's
 * account id, the exact coordinates, and the `status`/`updatedAt` bookkeeping
 * never reach the wire here. The projection is a wire concern only -
 * `ListingService` keeps returning the full row for owner-scoped reads and
 * mutations, and every public surface maps through this module.
 *
 * Each photo field means one thing on one read. `primaryPhotoUrl` is the
 * search card's image and travels on the feed only; `photos` is the complete
 * ordered gallery and travels on the detail read only.
 *
 * `publishedAt` is the timestamp a visitor reads as recency; the newest-first
 * sort key is `createdAt`, which only travels inside the encoded `nextCursor`.
 */
const PublicListingPhoto = Schema.Struct({
  id: ListingPhotoId,
  url: Schema.String,
});

const PublicListingFields = {
  id: ListingSchema.fields.id,
  kind: ListingSchema.fields.kind,
  title: ListingSchema.fields.title,
  description: ListingSchema.fields.description,
  priceMinor: ListingSchema.fields.priceMinor,
  currency: ListingSchema.fields.currency,
  regionCode: ListingSchema.fields.regionCode,
  sizeSqm: ListingSchema.fields.sizeSqm,
  furnished: ListingSchema.fields.furnished,
  ensuite: ListingSchema.fields.ensuite,
  smoking: ListingSchema.fields.smoking,
  pets: ListingSchema.fields.pets,
  availableFrom: ListingSchema.fields.availableFrom,
  publishedAt: ListingSchema.fields.publishedAt,
};

const PublicListingFeedItemSchema = Schema.Struct({
  ...PublicListingFields,
  // The feed's card image: the gallery's first photo, or null without one.
  primaryPhotoUrl: Schema.NullishOr(Schema.String),
});
export type PublicListingFeedItem = typeof PublicListingFeedItemSchema.Type;

const PublicListingSchema = Schema.Struct({
  ...PublicListingFields,
  // The whole gallery, in the order the detail page renders it.
  photos: Schema.Array(PublicListingPhoto),
});
export type PublicListing = typeof PublicListingSchema.Type;

const toPublicListingFields = (
  listing: typeof ListingSchema.Type,
): Omit<typeof PublicListingSchema.Type, "photos"> => ({
  id: listing.id,
  kind: listing.kind,
  title: listing.title,
  description: listing.description,
  priceMinor: listing.priceMinor,
  currency: listing.currency,
  regionCode: listing.regionCode,
  sizeSqm: listing.sizeSqm,
  furnished: listing.furnished,
  ensuite: listing.ensuite,
  smoking: listing.smoking,
  pets: listing.pets,
  availableFrom: listing.availableFrom,
  publishedAt: listing.publishedAt,
});

const toPublicPhoto = (
  listingId: typeof ListingId.Type,
  photo: ListingPhoto,
): (typeof PublicListingSchema.Type)["photos"][number] => ({
  id: photo.id,
  url: listingPhotoUrl(listingId, photo.id),
});

export const toPublicListing = (
  listing: typeof ListingSchema.Type,
  photos: ReadonlyArray<ListingPhoto>,
): PublicListing => ({
  ...toPublicListingFields(listing),
  photos: photos.map((photo) => toPublicPhoto(listing.id, photo)),
});

export const toPublicListingFeedItem = (
  listing: typeof ListingSchema.Type,
  primaryPhoto: ListingPhoto | undefined,
): PublicListingFeedItem => ({
  ...toPublicListingFields(listing),
  primaryPhotoUrl: primaryPhoto === undefined ? null : listingPhotoUrl(listing.id, primaryPhoto.id),
});

export const PublicListingPageResponse = Schema.Struct({
  items: Schema.Array(PublicListingFeedItemSchema),
  nextCursor: Schema.NullishOr(ListingCursorFromString),
});
export type PublicListingPageResponse = typeof PublicListingPageResponse.Type;

export const toPublicListingPage = (
  page: typeof ListingPage.Type,
  firstPhotos: ReadonlyMap<number, ListingPhoto>,
): PublicListingPageResponse => ({
  items: page.items.map((listing) =>
    toPublicListingFeedItem(listing, firstPhotos.get(Number(listing.id))),
  ),
  nextCursor: page.nextCursor,
});

/*
 * The map's projection, and the only place a stored coordinate is rounded. A
 * pin carries the rounded pair itself - there is no raw coordinate anywhere on
 * the wire, no debug field, and no second projection that could skip the rule.
 * A row without a coordinate is a repository bug (the SQL already requires
 * both), so it dies here instead of publishing a `null` pin.
 */
export const toPublicListingPin = (
  listing: typeof ListingSchema.Type,
): (typeof ListingPinPage.Type)["pins"][number] => {
  if (listing.lat == null || listing.lng == null) {
    throw new Error("A listing without coordinates cannot become a map pin");
  }
  const approximate = approximateLocation(listing.lat, listing.lng);
  return {
    id: listing.id,
    kind: listing.kind,
    title: listing.title,
    priceMinor: listing.priceMinor,
    currency: listing.currency,
    regionCode: listing.regionCode,
    sizeSqm: listing.sizeSqm,
    lat: approximate.lat,
    lng: approximate.lng,
  };
};

export const PublicListingPinPageResponse = ListingPinPage;
export type PublicListingPinPageResponse = typeof ListingPinPage.Type;
export const toPublicListingPinPage = (rows: {
  readonly items: ReadonlyArray<typeof ListingSchema.Type>;
  readonly truncated: boolean;
}): typeof ListingPinPage.Type => ({
  pins: rows.items.map(toPublicListingPin),
  truncated: rows.truncated,
});

/*
 * `search` is the bare `/` under the `/listings` prefix and `detail` is
 * `/:id`, so the two can never shadow each other: the search route has no
 * second segment to capture, and the router prefers the registered literal
 * `/listings/new` over `/:id`.
 */
export const ListingsGroup = HttpApiGroup.make("listings")
  .add(
    HttpApiEndpoint.get("search", "/", {
      query: ListingSearchQuery,
      success: PublicListingPageResponse,
      error: [InternalError],
    }),
  )
  /*
   * The map is a literal route. The router resolves a static path before a
   * parametric one, so `/listings/map` can never be swallowed by `/:id`;
   * registering it before `detail` keeps the intent visible as well.
   *
   * The endpoint is kept deliberately even though the `/map` page reads the
   * service directly: it is the public read contract for the map, carrying the
   * same filter vocabulary the feed speaks, and the search page's map toggle is
   * its planned consumer. The page embedding its own pins is an implementation
   * choice, not a reason to drop the contract.
   */
  .add(
    HttpApiEndpoint.get("map", "/map", {
      query: ListingMapQuery,
      success: PublicListingPinPageResponse,
      error: [InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/:id", {
      params: { id: ListingId },
      success: PublicListingSchema,
      // A draft or unlisted listing answers the same 404 as an unknown id, so a
      // visitor cannot probe which ids exist.
      error: [ListingNotFoundError, InternalError],
    }),
  )
  .prefix("/listings");

export const PublicApi = HttpApi.make("public").add(AuthGroup).add(ListingsGroup).prefix("/api");

const searchResultsRoute = HttpRouter.route(
  "GET",
  "/search/results",
  Effect.gen(function* () {
    const searchParams = yield* HttpServerRequest.ParsedSearchParams;
    const listingService = yield* ListingService;

    // The form collects euros; the listings API filters on minor units, so the
    // helper converts and rounds before decoding.
    const query = yield* Schema.decodeUnknownEffect(ListingSearchQueryCodec)(
      withMinorUnitPrices(searchParams),
    );
    const { limit, cursor, ...filters } = query;
    const page = yield* listingService.search(filters, { limit, cursor });
    const photoService = yield* ListingPhotoService;
    const firstPhotos = yield* photoService.firstPhotos(page.items.map((item) => item.id));

    return HttpServerResponse.html(
      searchResults(
        page,
        new Map(
          Array.from(firstPhotos, ([listingId, photo]) => [
            listingId,
            listingPhotoUrl(photo.listingId, photo.id),
          ]),
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      // htmx only swaps 2xx responses by default, so a bad filter has to come
      // back as 200 with the error fragment; a 4xx here would leave the page
      // showing the previous results with no explanation. The JSON endpoint
      // still rejects bad filters with the runtime's 400.
      SchemaError: () =>
        Effect.succeed(
          HttpServerResponse.text(searchResultsError("Those filters could not be read."), {
            contentType: "text/html",
          }),
        ),
      InternalError: () =>
        Effect.succeed(
          HttpServerResponse.text(searchResultsError("Search failed. Please try again."), {
            status: 500,
            contentType: "text/html",
          }),
        ),
    }),
  ),
);

/*
 * The public page for one listing. It answers the same 404 page for an unknown
 * id, a draft, and an unlisted listing, because `getPublic` already collapses
 * those into one error and the page must not reveal which case it was. A path
 * segment that is not an id never reaches the service.
 */
const notFoundResponse = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(listingNotFoundPage(), { status: 404, contentType: "text/html" });

const listingDetailRoute = HttpRouter.route("GET", "/listings/:id", () =>
  Effect.gen(function* () {
    const id = yield* Effect.map(HttpRouter.params, (params) => decodeListingId(params["id"]));
    if (id === undefined) return notFoundResponse();

    const listingService = yield* ListingService;
    const listing = yield* listingService.getPublic(id);
    const photoService = yield* ListingPhotoService;
    const photos = yield* photoService.listPublic(id);
    return HttpServerResponse.html(listingDetailPage(toPublicListing(listing, photos)));
  }).pipe(
    Effect.catchTags({
      ListingNotFoundError: () => Effect.succeed(notFoundResponse()),
      InternalError: () =>
        Effect.succeed(
          HttpServerResponse.text(listingUnavailablePage(), {
            status: 500,
            contentType: "text/html",
          }),
        ),
    }),
  ),
);

/*
 * One gallery photo's bytes. The URL names the listing and the photo, never a
 * storage key: the row is looked up first, so an unknown or another listing's
 * photo id is the same 404. A published listing's photos are public; a draft or
 * unlisted listing's photos are served only to its signed-in owner (the edit
 * page preview), and anyone else gets the same 404 as a missing photo.
 *
 * Nothing here can list the bucket, and no request can name a key. The content
 * type comes from the validated row, not from the request or the upload's
 * filename.
 */
const photoNotFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("Not found", { status: 404 });

const listingPhotoRoute = HttpRouter.route("GET", "/listings/:id/photos/:photoId", (request) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const listingId = decodeListingId(params["id"]);
    const photoId = decodeListingPhotoId(params["photoId"]);
    if (listingId === undefined || photoId === undefined) return photoNotFound();

    // The public router has no auth middleware, so the session is optional: an
    // invalid or missing cookie is simply an anonymous visitor here.
    const viewerId = yield* callerId(request).pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );

    const photoService = yield* ListingPhotoService;
    const found = yield* photoService.read(listingId, photoId, viewerId);
    if (Option.isNone(found)) return photoNotFound();

    const { photo, object, private: isPrivate } = found.value;
    const headers = new Headers({
      "content-type": photo.contentType,
      "content-length": String(photo.byteSize),
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      etag: object.httpEtag,
      "cache-control": isPrivate
        ? "private, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable",
    });
    return HttpServerResponse.fromWeb(new Response(object.body, { status: 200, headers }));
  }).pipe(
    Effect.catchTag("InternalError", (error) =>
      Effect.logError("Photo read failed", { error }).pipe(
        Effect.andThen(
          Effect.succeed(HttpServerResponse.text("The photo is unavailable.", { status: 500 })),
        ),
      ),
    ),
  ),
);

/*
 * The map page. Pins are read through the same service as the map endpoint and
 * projected through the same function, so the page and the API cannot disagree
 * about which listings exist or where their pins are. The archive URL comes from
 * `PMTILES_GREECE`, resolved with the app layer, so swapping in the supplied
 * archive is a config change.
 */
const mapRoute = HttpRouter.route("GET", "/map", () =>
  Effect.gen(function* () {
    const listingService = yield* ListingService;
    const rows = yield* listingService.mapPins({}, LISTING_MAP_DEFAULT_LIMIT);
    const basemapUrl = yield* MapBasemapUrl;
    return HttpServerResponse.html(
      mapPage({
        basemapUrl,
        pins: rows.items.map(toPublicListingPin),
        truncated: rows.truncated,
      }),
    );
  }).pipe(
    Effect.catchTag("InternalError", (error) =>
      Effect.logError("Map page failed", { error }).pipe(
        Effect.andThen(
          Effect.succeed(
            HttpServerResponse.text(mapUnavailablePage(), {
              status: 500,
              contentType: "text/html",
            }),
          ),
        ),
      ),
    ),
  ),
);

export const PublicRoutes = HttpRouter.addAll([
  searchResultsRoute,
  listingPhotoRoute,
  listingDetailRoute,
  mapRoute,
  MapTilesRoute,
  HttpRouter.route("GET", "/search", Effect.succeed(HttpServerResponse.html(searchPage))),
  HttpRouter.route(
    "GET",
    "/",
    Effect.succeed(
      HttpServerResponse.html(`
        <!doctype html>
        <html>
          <body>
            <h1>Hello!</h1>
          </body>
        </html>
      `),
    ),
  ),
  HttpRouter.route("GET", "/login", Effect.succeed(HttpServerResponse.html(loginPage()))),
  HttpRouter.route("GET", "/register", Effect.succeed(HttpServerResponse.html(registerPage()))),
  ...AuthPageRoutes,
  ...SessionRoutes,
]);
