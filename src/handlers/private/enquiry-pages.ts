import { EnquiriesPageQueryCodec } from "@/db/schema/Enquiry";
import { decodeListingId } from "@/db/schema/Listing";
import { toPublicListing } from "@/api/public";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import { callerId } from "@/handlers/private/caller";
import { renderListingDetail } from "@/handlers/listing-detail-view";
import { enquiriesPage } from "@/frontend/pages/enquiries";
import { listingNotFoundPage, listingUnavailablePage } from "@/frontend/pages/listing-detail";
import { pageShell } from "@/frontend/layout";
import {
  EnquiryListingNotFoundError,
  EnquiryOwnListingError,
  EnquiryRateLimitedError,
  EnquiryService,
  EnquiryValidationError,
} from "@/services/enquiry.service";
import { ListingService } from "@/services/listing.service";
import { ListingPhotoService } from "@/services/listing-photo.service";
import type { InternalError } from "@/services/user.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";
import { Effect, Option, Result, Schema } from "effect";
import { escapeHtml } from "@/utils";

/*
 * The contact path's pages, on the private router so `AuthMiddleware` gates
 * them: a signed-out visitor gets the sign-in prompt, not a bare 401. The send
 * is a plain form post from the public detail page, answered with the enquiries
 * page on success or the detail page again - with the typed message and the
 * reason - when it is refused.
 */

type EnquiryPageError =
  | EnquiryListingNotFoundError
  | EnquiryOwnListingError
  | EnquiryValidationError
  | EnquiryRateLimitedError
  | InternalError;

const respond = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

const seeOther = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location, { status: 303 });

const errorPage = (title: string, message: string) =>
  pageShell(
    title,
    `
    <h1 class="text-2xl font-semibold text-gray-900">${escapeHtml(title)}</h1>
    <p class="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
      ${escapeHtml(message)}
    </p>
    <p class="mt-6 flex flex-wrap items-center gap-3">
      <a href="/enquiries" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Enquiries</a>
      <a href="/search" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Back to search</a>
    </p>`,
  );

// One readable sentence per refusal, and the status that goes with it. The
// listing-not-found case never reaches here: it is answered by the public
// not-found page, exactly as an anonymous reader would see it.
const describeEnquiryError = (
  error: Exclude<EnquiryPageError, EnquiryListingNotFoundError>,
): { readonly message: string; readonly status: number } => {
  switch (error._tag) {
    case "EnquiryValidationError":
      return { message: error.message, status: 400 };
    case "EnquiryOwnListingError":
      return {
        message: "This is your own listing, so there is nobody to send an enquiry to.",
        status: 409,
      };
    case "EnquiryRateLimitedError":
      return {
        message:
          "You have sent a lot of enquiries in the last hour. Please wait a little before sending another.",
        status: 429,
      };
    case "InternalError":
      return {
        message: "Your enquiry could not be sent just now. Please try again.",
        status: 500,
      };
  }
};

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

// An HTML form submits every named field, so absent and blank are the same; a
// repeated field keeps its first value.
const formText = (
  params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  name: string,
): string => {
  const value = params[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? (value[0] ?? "") : "";
};

/*
 * Both lists in one read. `received` is every enquiry on a listing the caller
 * owns, `sent` is every enquiry the caller sent; the service scopes both by the
 * session's account, so this page never decides whose rows those are.
 */
const getEnquiriesPage = HttpRouter.route("GET", "/enquiries", () =>
  Effect.gen(function* () {
    const viewerId = yield* callerId;
    const service = yield* EnquiryService;
    const params = yield* HttpServerRequest.ParsedSearchParams;
    const query = yield* Schema.decodeUnknownEffect(EnquiriesPageQueryCodec)(params);
    const received = yield* service.listReceived(viewerId, query.receivedCursor);
    const sent = yield* service.listSent(viewerId, query.sentCursor);
    const sentBanner = query.sent === "1";
    return respond(
      enquiriesPage({
        received,
        sent,
        receivedCursor: query.receivedCursor,
        sentCursor: query.sentCursor,
        sentBanner,
      }),
      200,
    );
  }).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.succeed(
        respond(
          errorPage(
            "That page link could not be read",
            "The page link is malformed. Open Enquiries again.",
          ),
          400,
        ),
      ),
    ),
    Effect.catchTags({
      InternalError: () =>
        Effect.succeed(
          respond(
            errorPage("Something went wrong", "Your enquiries could not be loaded just now."),
            500,
          ),
        ),
    }),
  ),
);

/*
 * Sending from the detail page. The listing id is the path, the message is the
 * form, and the sender is the session - a client cannot name another account.
 * A refused submit returns to the listing it came from so the person keeps what
 * they typed, except for a missing listing, which is the public 404.
 */
const sendEnquiry = HttpRouter.route("POST", "/listings/:id/enquiries", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) {
      return respond(errorPage("That form did not come from this site", crossSiteFormMessage), 403);
    }

    const id = yield* Effect.map(HttpRouter.params, (params) => decodeListingId(params["id"]));
    if (id === undefined) return respond(listingNotFoundPage(), 404);

    const params = yield* readForm(request);
    const message = formText(params, "message");
    const senderId = yield* callerId;
    const service = yield* EnquiryService;

    const outcome = yield* Effect.result(service.send(senderId, id, { message }));
    if (Result.isSuccess(outcome)) return seeOther("/enquiries?sent=1");

    const error = outcome.failure;
    if (error._tag === "EnquiryListingNotFoundError") {
      return respond(listingNotFoundPage(), 404);
    }
    if (error._tag === "InternalError") {
      return respond(listingUnavailablePage(), 500);
    }

    const listingService = yield* ListingService;
    const listing = yield* Effect.result(listingService.getPublic(id));
    if (Result.isFailure(listing)) {
      return listing.failure._tag === "ListingNotFoundError"
        ? respond(listingNotFoundPage(), 404)
        : respond(listingUnavailablePage(), 500);
    }

    const { message: reason, status } = describeEnquiryError(error);
    const photoService = yield* ListingPhotoService;
    const photos = yield* Effect.result(photoService.listPublic(id));
    if (Result.isFailure(photos)) return respond(listingUnavailablePage(), 500);
    const html = yield* Effect.result(
      renderListingDetail(
        toPublicListing(listing.success, photos.success),
        listing.success.ownerId,
        Option.some(senderId),
        {
          message,
          error: reason,
        },
      ),
    );
    if (Result.isFailure(html)) return respond(listingUnavailablePage(), 500);
    return respond(html.success, status);
  }),
);

// Exported as routes rather than a layer so the private router can register
// them next to its other pages under one auth middleware.
export const EnquiryPageRoutes = [getEnquiriesPage, sendEnquiry];
