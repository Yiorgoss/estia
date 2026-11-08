import {
  decodeListingId,
  encodeListingCursor,
  LISTING_PAGE_DEFAULT_LIMIT,
  ListingCursor,
  ListingCursorFromString,
  ListingMineQueryCodec,
} from "@/db/schema/Listing";
import { crossSiteFormMessage, isSameOriginFormPost } from "@/handlers/form-origin";
import { callerId } from "@/handlers/private/caller";
import {
  decodeCreateListingForm,
  decodeUpdateListingForm,
  emptyListingFormValues,
  listingFormValues,
  listingFormValuesFor,
} from "@/frontend/listing-form";
import { editListingPage, listingErrorPage, newListingPage } from "@/frontend/pages/listing-form";
import { myListingsPage } from "@/frontend/pages/my-listings";
import { UnauthorizedError } from "@/services/auth.service";
import {
  InvalidListingTransitionError,
  ListingLocationOutOfGreeceError,
  ListingNotFoundError,
  ListingNotOwnedError,
  ListingService,
  ListingValidationError,
} from "@/services/listing.service";
import type { InternalError } from "@/services/user.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";
import { Effect, Option, Schema } from "effect";

/*
 * Owner-facing listing pages. They live on the private router, so `AuthMiddleware`
 * gates them, answering a signed-out visitor with the sign-in prompt page rather
 * than the JSON API's 401 body, and the caller's id reaches `ListingService` as
 * the owner exactly as in the API handlers. Every submit is answered with a page,
 * so a rejected form shows its reason instead of an empty document.
 */

type ListingPageError =
  | ListingValidationError
  | ListingLocationOutOfGreeceError
  | ListingNotFoundError
  | ListingNotOwnedError
  | InvalidListingTransitionError
  | UnauthorizedError
  | InternalError;

interface PageError {
  readonly title: string;
  readonly message: string;
  readonly status: number;
}

const locationMessage =
  "Those coordinates are outside Greece. Latitude must be between 34.0 and 42.5 and longitude between 19.0 and 30.5.";

const describeError = (error: ListingPageError): PageError => {
  switch (error._tag) {
    case "ListingValidationError":
      return { title: "That listing could not be saved", message: error.message, status: 400 };
    case "ListingLocationOutOfGreeceError":
      return {
        title: "Those coordinates are outside Greece",
        message: locationMessage,
        status: 422,
      };
    case "ListingNotFoundError":
      return {
        title: "Listing not found",
        message: "That listing does not exist, or it is not yours to manage.",
        status: 404,
      };
    case "ListingNotOwnedError":
      return {
        title: "That listing belongs to another account",
        message: "Only the owner can edit, publish, or unlist a listing.",
        status: 403,
      };
    case "InvalidListingTransitionError":
      return {
        title: "That status change is not possible",
        message:
          error.to === "published"
            ? "This listing is already published."
            : "Only a published listing can be unlisted.",
        status: 409,
      };
    case "UnauthorizedError":
      return {
        title: "Sign in required",
        message: "Sign in to manage your listings.",
        status: 401,
      };
    case "InternalError":
      return {
        title: "Something went wrong",
        message: "The listing could not be loaded or saved just now. Please try again.",
        status: 500,
      };
  }
};

const respond = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

const seeOther = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location, { status: 303 });

const errorResponse = (error: ListingPageError): HttpServerResponse.HttpServerResponse => {
  const { title, message, status } = describeError(error);
  return respond(listingErrorPage(title, message), status);
};

const missingListingResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(listingErrorPage("Listing not found", "That listing does not exist."), 404);

/*
 * These routes change a listing, and their forms are simple requests, so the
 * browser will post one from another site with the lister's cookies attached.
 * `SameSite=Lax` keeps the session off such a post, and the shared origin check
 * keeps the route itself from relying on that one cookie attribute.
 */
const crossSiteResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(listingErrorPage("That form did not come from this site", crossSiteFormMessage), 403);

// A body that cannot be read is a broken request, not a listing failure, so it
// is a defect rather than something the pages explain.
const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

const getNewListingPage = HttpRouter.route(
  "GET",
  "/listings/new",
  Effect.succeed(respond(newListingPage(emptyListingFormValues), 200)),
);

/*
 * The owner's own feed. The cursor is the model's opaque token, so paging is a
 * link carrying it and a malformed one is a readable 400 rather than a silent
 * first page. The page size stays the model's default: the page is not a place
 * to ask for an arbitrary slice, so a `limit` in the link is decoded with the
 * shared query codec but never used.
 */
const mineHref = (cursor?: string): string =>
  cursor === undefined ? "/listings/mine" : `/listings/mine?cursor=${cursor}`;

const mineHrefFor = (cursor: typeof ListingCursor.Type | undefined): string =>
  mineHref(cursor === undefined ? undefined : encodeListingCursor(cursor));

const minePageRequest = (cursor?: typeof ListingCursor.Type) => ({
  limit: LISTING_PAGE_DEFAULT_LIMIT,
  cursor,
});

const getMyListingsPage = HttpRouter.route("GET", "/listings/mine", (request) =>
  Effect.gen(function* () {
    const searchParams = yield* HttpServerRequest.ParsedSearchParams;
    const query = yield* Schema.decodeUnknownEffect(ListingMineQueryCodec)(searchParams);
    const ownerId = yield* callerId(request);
    const listingService = yield* ListingService;
    const page = yield* listingService.listMine(ownerId, minePageRequest(query.cursor));
    return respond(myListingsPage(page, { selfHref: mineHrefFor(query.cursor) }), 200);
  }).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.succeed(
        respond(
          listingErrorPage(
            "That page link could not be read",
            "The page link is malformed. Open My listings again.",
          ),
          400,
        ),
      ),
    ),
    Effect.catch((error: ListingPageError) => Effect.succeed(errorResponse(error))),
  ),
);

/*
 * A draft is created here and the owner lands on its edit page. Its publish and
 * unlist controls live there and on the mine page; both post to the transition
 * routes below.
 */
const createListing = HttpRouter.route("POST", "/listings/new", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginFormPost(request)) return crossSiteResponse();

    const params = yield* readForm(request);
    const values = listingFormValues(params);
    const decoded = decodeCreateListingForm(params);
    if (!decoded.ok) {
      return respond(newListingPage(values, decoded.message), 400);
    }

    return yield* Effect.gen(function* () {
      const ownerId = yield* callerId(request);
      const listingService = yield* ListingService;
      const listing = yield* listingService.createDraft(ownerId, decoded.input);
      return seeOther(`/listings/${listing.id}/edit`);
    }).pipe(
      Effect.catch((error: ListingPageError) => {
        const { message, status } = describeError(error);
        return Effect.succeed(respond(newListingPage(values, message), status));
      }),
    );
  }),
);

const getEditListingPage = HttpRouter.route("GET", "/listings/:id/edit", (request) =>
  Effect.gen(function* () {
    const id = yield* Effect.map(HttpRouter.params, (params) => decodeListingId(params["id"]));
    if (id === undefined) return missingListingResponse();

    const ownerId = yield* callerId(request);
    const listingService = yield* ListingService;
    const listing = yield* listingService.getOwn(ownerId, id);
    return respond(editListingPage(listing, listingFormValuesFor(listing)), 200);
  }).pipe(Effect.catch((error: ListingPageError) => Effect.succeed(errorResponse(error)))),
);

const updateListing = HttpRouter.route("POST", "/listings/:id/edit", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginFormPost(request)) return crossSiteResponse();

    const id = yield* Effect.map(HttpRouter.params, (params) => decodeListingId(params["id"]));
    if (id === undefined) return missingListingResponse();

    const params = yield* readForm(request);
    const values = listingFormValues(params);
    const decoded = decodeUpdateListingForm(params);
    const ownerId = yield* callerId(request);
    const listingService = yield* ListingService;
    // Loading first means a rejected submit is answered with the edit page as it
    // stands, including the current status and the existing values.
    const current = yield* listingService.getOwn(ownerId, id);

    if (!decoded.ok) {
      return respond(editListingPage(current, values, decoded.message), 400);
    }

    return yield* listingService.updateListing(ownerId, id, decoded.input).pipe(
      Effect.map(() => seeOther(`/listings/${id}/edit`)),
      Effect.catch((error: ListingPageError) => {
        const { message, status } = describeError(error);
        return Effect.succeed(respond(editListingPage(current, values, message), status));
      }),
    );
  }).pipe(Effect.catch((error: ListingPageError) => Effect.succeed(errorResponse(error)))),
);

/*
 * A publish or unlist form may name the page it came from. Only the mine page is
 * accepted - with or without a cursor - so the value can never become an open
 * redirect, and an unnamed or unrecognised one keeps the edit page as the
 * destination, which is where those actions have always returned.
 */
const MINE_RETURN_TO = /^\/listings\/mine(?:\?cursor=([A-Za-z0-9_-]+))?$/;

type ReturnTo =
  | { readonly page: "edit" }
  | { readonly page: "mine"; readonly cursor: typeof ListingCursor.Type | undefined };

// A form posts one `returnTo` value. A missing value, or a repeated field that
// arrives as an array, keeps the edit page as the destination.
const decodeReturnTo = (raw: string | ReadonlyArray<string> | undefined): ReturnTo => {
  if (typeof raw !== "string") return { page: "edit" };
  const match = MINE_RETURN_TO.exec(raw);
  if (match === null) return { page: "edit" };
  const cursor =
    match[1] === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(ListingCursorFromString)(match[1]));
  return { page: "mine", cursor };
};

const transitionRoute = (action: "publish" | "unlist") =>
  HttpRouter.route("POST", `/listings/:id/${action}`, (request) =>
    Effect.gen(function* () {
      if (!isSameOriginFormPost(request)) return crossSiteResponse();

      const id = yield* Effect.map(HttpRouter.params, (params) => decodeListingId(params["id"]));
      if (id === undefined) return missingListingResponse();

      const params = yield* readForm(request);
      const returnTo = decodeReturnTo(params["returnTo"]);
      const ownerId = yield* callerId(request);
      const listingService = yield* ListingService;
      const move =
        action === "publish"
          ? listingService.publish(ownerId, id)
          : listingService.unlist(ownerId, id);

      // A rejected transition is explained where its owner can act on it: the
      // mine page re-reads its rows and repeats the message above them, the edit
      // page shows the listing as it stands now.
      const rejected = (error: ListingPageError) => {
        const { message, status } = describeError(error);
        if (returnTo.page === "edit") {
          return listingService.getOwn(ownerId, id).pipe(
            Effect.map((current) =>
              respond(editListingPage(current, listingFormValuesFor(current), message), status),
            ),
            Effect.orElseSucceed(() => errorResponse(error)),
          );
        }
        return listingService.listMine(ownerId, minePageRequest(returnTo.cursor)).pipe(
          Effect.map((page) =>
            respond(
              myListingsPage(page, { selfHref: mineHrefFor(returnTo.cursor), error: message }),
              status,
            ),
          ),
          Effect.orElseSucceed(() => errorResponse(error)),
        );
      };

      return yield* move.pipe(
        Effect.map(() =>
          seeOther(
            returnTo.page === "mine" ? mineHrefFor(returnTo.cursor) : `/listings/${id}/edit`,
          ),
        ),
        Effect.catch(rejected),
      );
    }).pipe(Effect.catch((error: ListingPageError) => Effect.succeed(errorResponse(error)))),
  );

// Exported as routes rather than a layer so the private router can register
// them next to its other routes under one auth middleware.
export const ListingPageRoutes = [
  getNewListingPage,
  getMyListingsPage,
  createListing,
  getEditListingPage,
  updateListing,
  transitionRoute("publish"),
  transitionRoute("unlist"),
];
