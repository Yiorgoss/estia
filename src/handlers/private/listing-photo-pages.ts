import { ListingId, UserId } from "@/db/schema/brands";
import { decodeListingId } from "@/db/schema/Listing";
import { decodeListingPhotoId, LISTING_PHOTO_MAX_BYTES } from "@/db/schema/ListingPhoto";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import { callerId } from "@/handlers/private/caller";
import { listingFormValuesFor } from "@/frontend/listing-form";
import { editListingPage, listingErrorPage } from "@/frontend/pages/listing-form";
import { UnauthorizedError } from "@/services/auth.service";
import {
  ListingPhotoLimitError,
  ListingPhotoNotFoundError,
  ListingPhotoService,
  ListingPhotoValidationError,
} from "@/services/listing-photo.service";
import {
  ListingNotFoundError,
  ListingNotOwnedError,
  ListingService,
} from "@/services/listing.service";
import type { InternalError } from "@/services/user.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";
import type { Multipart } from "effect/http";
import type { MultipartError } from "effect/http/Multipart";
import { Effect, Stream } from "effect";

/*
 * The owner-facing gallery routes. They live on the private router, so
 * `AuthMiddleware` answers a signed-out visitor before anything is read, and
 * every mutation names the listing it targets so `ListingPhotoService` can
 * refuse another account's listing with a 403 - not merely hide it.
 *
 * The only way bytes enter storage is the authenticated upload route below. It
 * accepts a multipart body, streams each file with a hard byte limit, and hands
 * the bytes to the service, which re-checks the declared type against the actual
 * magic bytes before it generates a key. There is no anonymous upload route, no
 * caller-supplied key, and no bucket listing anywhere on the worker.
 */

type PhotoPageError =
  | ListingPhotoValidationError
  | ListingPhotoLimitError
  | ListingPhotoNotFoundError
  | ListingNotFoundError
  | ListingNotOwnedError
  | UnauthorizedError
  | InternalError;

interface PageError {
  readonly title: string;
  readonly message: string;
  readonly status: number;
}

const describeError = (error: PhotoPageError): PageError => {
  switch (error._tag) {
    case "ListingPhotoValidationError":
      return { title: "That photo could not be added", message: error.message, status: 400 };
    case "ListingPhotoLimitError":
      return {
        title: "That gallery is full",
        message: `A listing can have at most ${error.limit} photos.`,
        status: 400,
      };
    case "ListingPhotoNotFoundError":
      return {
        title: "Photo not found",
        message: "That photo does not exist on this listing.",
        status: 404,
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
        message: "Only the owner can change a listing's photos.",
        status: 403,
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
        message: "The photos could not be changed just now. Please try again.",
        status: 500,
      };
  }
};

const respond = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

const seeOther = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location, { status: 303 });

const errorResponse = (error: PhotoPageError): HttpServerResponse.HttpServerResponse => {
  const { title, message, status } = describeError(error);
  return respond(listingErrorPage(title, message), status);
};

const crossSiteResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(listingErrorPage("That form did not come from this site", crossSiteFormMessage), 403);

const missingListingResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(listingErrorPage("Listing not found", "That listing does not exist."), 404);

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

const listingIdOf = () => Effect.map(HttpRouter.params, (params) => decodeListingId(params["id"]));

const photoIdOf = () =>
  Effect.map(HttpRouter.params, (params) => decodeListingPhotoId(params["photoId"]));

/*
 * Re-renders the edit page with the gallery as it stands and the reason the
 * action was refused, so an owner can act on the answer instead of getting a
 * bare error document.
 */
const renderEdit = (
  ownerId: typeof UserId.Type,
  listingId: typeof ListingId.Type,
  message: string,
  status: number,
) =>
  Effect.gen(function* () {
    const listingService = yield* ListingService;
    const photoService = yield* ListingPhotoService;
    const current = yield* listingService.getOwn(ownerId, listingId);
    const photos = yield* photoService.listOwned(ownerId, listingId);
    return respond(
      editListingPage(current, listingFormValuesFor(current), message, photos),
      status,
    );
  }).pipe(Effect.catch((error: PhotoPageError) => Effect.succeed(errorResponse(error))));

const renderEditError = (
  ownerId: typeof UserId.Type,
  listingId: typeof ListingId.Type,
  error: PhotoPageError,
) => {
  const { message, status } = describeError(error);
  return renderEdit(ownerId, listingId, message, status);
};

/*
 * A multipart body that cannot be parsed is a broken request, not a gallery
 * rule. It still answers with the edit page so the owner sees why nothing was
 * added; a size-limit parser failure is a 413, everything else a 400.
 */
const renderMultipartError = (error: MultipartError): HttpServerResponse.HttpServerResponse => {
  const oversized =
    error.reason._tag === "FileTooLarge" ||
    error.reason._tag === "BodyTooLarge" ||
    error.reason._tag === "TooManyParts";
  return oversized
    ? respond(
        listingErrorPage(
          "That upload is too large",
          "Each photo must be 5 MB or smaller, and a listing can have at most 10 photos.",
        ),
        413,
      )
    : respond(
        listingErrorPage(
          "That upload could not be read",
          "The photos did not arrive in one piece. Choose them again and retry.",
        ),
        400,
      );
};

/*
 * Reads one file part, stopping as soon as the byte limit is crossed so an
 * oversized upload is rejected while it is still streaming. Only the bytes that
 * fit are buffered; the declared multipart type is checked against them later by
 * the service.
 */
const readPartBytes = (
  file: Multipart.File,
): Effect.Effect<Uint8Array, ListingPhotoValidationError | MultipartError> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* file.content.pipe(
      Stream.runForEach((chunk) => {
        size += chunk.length;
        if (size > LISTING_PHOTO_MAX_BYTES) {
          return Effect.fail(
            new ListingPhotoValidationError({ message: "Each photo must be 5 MB or smaller." }),
          );
        }
        chunks.push(chunk);
        return Effect.void;
      }),
    );

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  });

/*
 * Runs one gallery action with the owner already established. A rule failure or
 * a missing photo re-renders the edit page; a request that never proved a
 * session is a 401 page. This keeps the ownership check in one place instead of
 * restating it in every route.
 */
const ownedAction = <R>(
  listingId: typeof ListingId.Type,
  action: (
    ownerId: typeof UserId.Type,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, PhotoPageError, R>,
) =>
  Effect.gen(function* () {
    const ownerId = yield* callerId;
    return yield* action(ownerId).pipe(
      Effect.catch((error: PhotoPageError) => renderEditError(ownerId, listingId, error)),
    );
  });

const uploadPhotos = HttpRouter.route("POST", "/listings/:id/photos", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const listingId = yield* listingIdOf();
    if (listingId === undefined) return missingListingResponse();

    return yield* ownedAction(listingId, (ownerId) =>
      Effect.gen(function* () {
        const photoService = yield* ListingPhotoService;

        let added = 0;
        yield* request.multipartStream.pipe(
          Stream.runForEach((part) =>
            part._tag === "File"
              ? Effect.gen(function* () {
                  const bytes = yield* readPartBytes(part);
                  yield* photoService.add(ownerId, listingId, {
                    declaredContentType: part.contentType,
                    bytes,
                  });
                  added += 1;
                })
              : Effect.void,
          ),
        );

        if (added === 0) {
          return yield* renderEdit(ownerId, listingId, "Choose at least one photo to upload.", 400);
        }
        return seeOther(`/listings/${listingId}/edit`);
      }).pipe(
        Effect.catchTag("MultipartError", (error) => Effect.succeed(renderMultipartError(error))),
      ),
    );
  }),
);

const movePhoto = HttpRouter.route("POST", "/listings/:id/photos/:photoId/move", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const listingId = yield* listingIdOf();
    const photoId = yield* photoIdOf();
    if (listingId === undefined || photoId === undefined) return missingListingResponse();

    return yield* ownedAction(listingId, (ownerId) =>
      Effect.gen(function* () {
        const params = yield* readForm(request);
        const raw = params["direction"];
        const direction = raw === "up" ? "up" : raw === "down" ? "down" : undefined;
        if (direction === undefined) {
          return yield* renderEdit(
            ownerId,
            listingId,
            "Choose whether to move that photo up or down.",
            400,
          );
        }

        const photoService = yield* ListingPhotoService;
        yield* photoService.move(ownerId, listingId, photoId, direction);
        return seeOther(`/listings/${listingId}/edit`);
      }),
    );
  }),
);

const makePhotoFirst = HttpRouter.route("POST", "/listings/:id/photos/:photoId/first", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const listingId = yield* listingIdOf();
    const photoId = yield* photoIdOf();
    if (listingId === undefined || photoId === undefined) return missingListingResponse();

    return yield* ownedAction(listingId, (ownerId) =>
      Effect.gen(function* () {
        const photoService = yield* ListingPhotoService;
        yield* photoService.makeFirst(ownerId, listingId, photoId);
        return seeOther(`/listings/${listingId}/edit`);
      }),
    );
  }),
);

const deletePhoto = HttpRouter.route("POST", "/listings/:id/photos/:photoId/delete", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const listingId = yield* listingIdOf();
    const photoId = yield* photoIdOf();
    if (listingId === undefined || photoId === undefined) return missingListingResponse();

    return yield* ownedAction(listingId, (ownerId) =>
      Effect.gen(function* () {
        const photoService = yield* ListingPhotoService;
        yield* photoService.remove(ownerId, listingId, photoId);
        return seeOther(`/listings/${listingId}/edit`);
      }),
    );
  }),
);

export const ListingPhotoPageRoutes = [uploadPhotos, movePhoto, makePhotoFirst, deletePhoto];
