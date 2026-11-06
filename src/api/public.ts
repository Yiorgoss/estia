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
import { RoomSchema, RoomSearchQuery, RoomSearchQueryCodec } from "@/db/schema/Room";
import { RoomSearchService } from "@/services/room-search.service";
import { omitEmptySearchParams } from "@/utils";
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

export const PublicApi = HttpApi.make("public").add(AuthGroup).add(RoomSearchGroup).prefix("/api");

const searchResultsRoute = HttpRouter.route(
  "GET",
  "/search/results",
  Effect.gen(function* () {
    const searchParams = yield* HttpServerRequest.ParsedSearchParams;
    const searchService = yield* RoomSearchService;

    const filters = yield* Schema.decodeUnknownEffect(RoomSearchQueryCodec)(
      omitEmptySearchParams(searchParams),
    );
    const rooms = yield* searchService.search(filters);

    return HttpServerResponse.html(searchResults(rooms));
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
      SqlError: () =>
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
