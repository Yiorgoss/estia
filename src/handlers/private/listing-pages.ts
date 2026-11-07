import { ListingId } from "@/db/schema/brands";
import { callerId } from "@/handlers/private/caller";
import {
  decodeCreateListingForm,
  decodeUpdateListingForm,
  emptyListingFormValues,
  listingFormValues,
  listingFormValuesFor,
} from "@/frontend/listing-form";
import { editListingPage, listingErrorPage, newListingPage } from "@/frontend/pages/listing-form";
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
import { Effect, Schema } from "effect";

/*
 * Owner-facing listing pages. They live on the private router, so `AuthMiddleware`
 * gates them the same way it gates the JSON API, and the caller's id reaches
 * `ListingService` as the owner exactly as in the API handlers. Every submit is
 * answered with a page, so a rejected form shows its reason instead of an empty
 * document.
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

// A body that cannot be read is a broken request, not a listing failure, so it
// is a defect rather than something the pages explain.
const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

// "new" is not an id, so anything that is not a positive integer is treated as
// a listing that does not exist rather than reaching the database.
const decodeListingId = (raw: string | undefined): typeof ListingId.Type | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return Schema.decodeSync(ListingId)(id);
};

const getNewListingPage = HttpRouter.route(
  "GET",
  "/listings/new",
  Effect.succeed(respond(newListingPage(emptyListingFormValues), 200)),
);

/*
 * A draft is created here and the owner lands on its edit page, which is where
 * publish lives.
 */
const createListing = HttpRouter.route("POST", "/listings/new", (request) =>
  Effect.gen(function* () {
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

const transitionRoute = (action: "publish" | "unlist") =>
  HttpRouter.route("POST", `/listings/:id/${action}`, (request) =>
    Effect.gen(function* () {
      const id = yield* Effect.map(HttpRouter.params, (params) => decodeListingId(params["id"]));
      if (id === undefined) return missingListingResponse();

      const ownerId = yield* callerId(request);
      const listingService = yield* ListingService;
      const move =
        action === "publish"
          ? listingService.publish(ownerId, id)
          : listingService.unlist(ownerId, id);

      return yield* move.pipe(
        Effect.map(() => seeOther(`/listings/${id}/edit`)),
        Effect.catch((error: ListingPageError) => {
          const { message, status } = describeError(error);
          // An illegal transition is best explained next to the listing as it is
          // now, so the page is re-read rather than rendered from a stale guess.
          return listingService.getOwn(ownerId, id).pipe(
            Effect.map((current) =>
              respond(editListingPage(current, listingFormValuesFor(current), message), status),
            ),
            Effect.orElseSucceed(() => errorResponse(error)),
          );
        }),
      );
    }).pipe(Effect.catch((error: ListingPageError) => Effect.succeed(errorResponse(error)))),
  );

// Exported as routes rather than a layer so the private router can register
// them next to its other routes under one auth middleware.
export const ListingPageRoutes = [
  getNewListingPage,
  createListing,
  getEditListingPage,
  updateListing,
  transitionRoute("publish"),
  transitionRoute("unlist"),
];
