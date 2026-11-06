import { UserCredentials } from "@/db/schema/User";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Effect, Schema } from "effect";
import { InvalidCredentialsError, UnauthorizedError } from "@/services/auth.service";
import { InternalError } from "@/services/user.service";
import { loginPage } from "@/frontend/pages/login";
import { registerPage } from "@/frontend/pages/register";
import { mapDemo } from "@/frontend/map-demo";
import { searchPage } from "@/frontend/pages/search";
import { searchResults, searchResultsError } from "@/frontend/search-results";
import { JWTSchema, RefreshTokenValue } from "@/db/schema/brands";
import { RoomSchema, RoomSearchQuery } from "@/db/schema/Room";
import {
  ListingCursorFromString,
  ListingPage,
  ListingSchema,
  ListingSearchQuery,
  ListingSearchQueryCodec,
} from "@/db/schema/Listing";
import { ListingService } from "@/services/listing.service";
import { withMinorUnitPrices } from "@/utils";
import { head } from "@/frontend/head";

const AuthGroup = HttpApiGroup.make("auth")
  .add(HttpApiEndpoint.post("test-post", "/test-post"))
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
      error: [InternalError],
    }),
  )
  // A group prefix only applies to the endpoints added before it.
  .prefix("/auth");

const RoomSearchGroup = HttpApiGroup.make("room-search")
  .add(
    HttpApiEndpoint.get("search", "/search", {
      query: RoomSearchQuery,
      success: Schema.Array(RoomSchema),
      error: [InternalError],
    }),
  )
  .prefix("/rooms");

/*
 * The feed is unauthenticated, so its wire shape is a projection of the listing
 * row, not the row itself: the owner's account id, the exact coordinates, and
 * the `status`/`updatedAt` bookkeeping never reach the wire here. The projection
 * is a wire concern only - `ListingService` keeps returning the full row for
 * owner-scoped reads and mutations.
 * `publishedAt` is the timestamp a visitor reads as recency; the newest-first
 * sort key is `createdAt`, which only travels inside the encoded `nextCursor`.
 */
const PublicListingSchema = Schema.Struct({
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
});

export const PublicListingPageResponse = Schema.Struct({
  items: Schema.Array(PublicListingSchema),
  nextCursor: Schema.NullishOr(ListingCursorFromString),
});
export type PublicListingPageResponse = typeof PublicListingPageResponse.Type;

export const toPublicListingPage = (
  page: typeof ListingPage.Type,
): typeof PublicListingPageResponse.Type => ({
  items: page.items.map((listing) => ({
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
  })),
  nextCursor: page.nextCursor,
});

export const ListingsGroup = HttpApiGroup.make("listings")
  .add(
    HttpApiEndpoint.get("search", "/", {
      query: ListingSearchQuery,
      success: PublicListingPageResponse,
      error: [InternalError],
    }),
  )
  .prefix("/listings");

export const PublicApi = HttpApi.make("public")
  .add(AuthGroup)
  .add(RoomSearchGroup)
  .add(ListingsGroup)
  .prefix("/api");

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

    return HttpServerResponse.html(searchResults(page));
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

export const PublicRoutes = HttpRouter.addAll([
  searchResultsRoute,
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
  HttpRouter.route("GET", "/login", Effect.succeed(HttpServerResponse.html(loginPage))),
  HttpRouter.route("GET", "/register", Effect.succeed(HttpServerResponse.html(registerPage))),
  HttpRouter.route("GET", "/map", Effect.succeed(HttpServerResponse.html(mapDemo))),
  HttpRouter.route(
    "GET",
    "/test",
    Effect.succeed(
      HttpServerResponse.html(
        `
          <!doctype html>
          <html>
            <head>
              ${head}
            </head>
            <body class="flex bg-gray-200 place-content-center min-h-lvh">
            
              <div id='result' class="font-2xl" style='background:purple;width:500px;height:100px'>
                nothing yet
              </div>
              <form
                hx-post="/api/auth/test-post"
                enctype="multipart/form-data"
                hx-target="#result"
                hx-swap="outerHTML"
                name="files"
                >
                  <input type='text' name="hi" />
                  <input type='file' name="file" />
                  <button type='submit'>Submit</button>
              </form>
            </body>
          </html>
            `,
      ),
    ),
  ),
]);
