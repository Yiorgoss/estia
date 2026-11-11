import {
  decodeSavedSearchId,
  SavedSearchName,
} from "@/db/schema/SavedSearch";
import { UserId } from "@/db/schema/brands";
import { ListingSearchQueryCodec } from "@/db/schema/Listing";
import { callerId } from "@/handlers/private/caller";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import { clearedNameInput, savedSearchesPanel } from "@/frontend/saved-search";
import type { SavedSearchesPanelOptions } from "@/frontend/saved-search";
import { SavedSearchService } from "@/services/saved-search.service";
import { omitBlankSearchText, withMinorUnitPrices } from "@/utils";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  UrlParams,
} from "effect/http";
import { Effect, Option, Result, Schema } from "effect";

/*
 * The browser paths for saved searches, next to the JSON endpoints. They live on
 * the private router, so `AuthMiddleware` gates them and `callerId` names the
 * account; every write also passes the shared origin check, because a sibling
 * site can post these forms with the session attached.
 *
 * A save and a delete answer the saved-search list fragment, which is the
 * element htmx targets. A request without htmx is answered with a redirect
 * instead, so a browser with no script still ends up on the search page rather
 * than staring at a fragment.
 */

const respond = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

const seeOther = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location, { status: 303 });

const isHtmx = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers["hx-request"] === "true";

/*
 * htmx only swaps 2xx responses, so a refused htmx save or delete has to answer
 * the list section with a 200 and the error banner; a 4xx would leave the old
 * list in place and the person would see nothing happen. A request without htmx
 * is a navigation and keeps the status that describes it.
 */
const refuse = (
  request: HttpServerRequest.HttpServerRequest,
  message: string,
): HttpServerResponse.HttpServerResponse =>
  isHtmx(request)
    ? respond(savedSearchesPanel([], { error: message }), 200)
    : respond(message, 403);

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

const panelError = "Your saved searches could not be loaded just now.";

/*
 * The list as the page shows it, with an optional banner. A failed read is
 * rendered inside the same section rather than becoming an empty page, so the
 * surrounding search page stays usable.
 */
const panelFor = (
  ownerId: typeof UserId.Type,
  options: SavedSearchesPanelOptions = {},
  extra = "",
) =>
  Effect.gen(function* () {
    const savedSearchService = yield* SavedSearchService;
    const listed = yield* Effect.result(savedSearchService.list(ownerId));
    if (Result.isFailure(listed)) {
      return respond(savedSearchesPanel([], { error: panelError }), 200);
    }
    return respond(`${savedSearchesPanel(listed.success, options)}${extra}`, 200);
  });

/*
 * Saving from the results page. The form's own field is the optional name; the
 * criteria arrive from the search form through `hx-include`, so the server reads
 * the same query parameters the results route reads and no criteria is trusted
 * from a hidden field. A blank name is left to the service, which names the
 * search after its criteria.
 */
const createSavedSearch = HttpRouter.route("POST", "/search/saved", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) {
      return refuse(request, crossSiteFormMessage);
    }

    const ownerId = yield* callerId;
    const params = yield* readForm(request);
    const { name: rawName, ...rawCriteria } = params;

    const nameCandidate =
      typeof rawName === "string" && rawName.trim() === "" ? undefined : rawName;
    const name =
      typeof nameCandidate === "string"
        ? Option.getOrUndefined(Schema.decodeUnknownOption(SavedSearchName)(nameCandidate))
        : undefined;
    if (typeof nameCandidate === "string" && name === undefined) {
      return yield* panelFor(ownerId, {
        error: "That name could not be used. Use 120 characters or fewer.",
      });
    }

    const decoded = Schema.decodeUnknownResult(ListingSearchQueryCodec)(
      withMinorUnitPrices(omitBlankSearchText(rawCriteria)),
    );
    if (Result.isFailure(decoded)) {
      return yield* panelFor(ownerId, { error: "Those filters could not be read." });
    }

    const { limit: _limit, cursor: _cursor, ...criteria } = decoded.success;
    const savedSearchService = yield* SavedSearchService;
    const created = yield* Effect.result(
      savedSearchService.create(ownerId, { name, ...criteria }),
    );
    if (Result.isFailure(created)) {
      return yield* panelFor(ownerId, {
        error: "This search could not be saved just now. Please try again.",
      });
    }

    if (!isHtmx(request)) return seeOther("/search");
    return yield* panelFor(
      ownerId,
      { notice: `Saved: ${created.success.name}` },
      clearedNameInput(),
    );
  }),
);

const deleteSavedSearch = HttpRouter.route("POST", "/search/saved/:id/delete", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) {
      return refuse(request, crossSiteFormMessage);
    }

    const ownerId = yield* callerId;
    const id = yield* Effect.map(HttpRouter.params, (params) =>
      decodeSavedSearchId(params["id"]),
    );
    if (id === undefined) {
      return yield* panelFor(ownerId, { error: "That saved search no longer exists." });
    }

    const savedSearchService = yield* SavedSearchService;
    const outcome = yield* Effect.result(savedSearchService.delete(ownerId, id));
    if (Result.isFailure(outcome)) {
      const error =
        outcome.failure._tag === "SavedSearchNotFoundError"
          ? "That saved search no longer exists."
          : "This saved search could not be deleted just now. Please try again.";
      return yield* panelFor(ownerId, { error });
    }

    if (!isHtmx(request)) return seeOther("/search");
    return yield* panelFor(ownerId, { notice: "Saved search deleted." });
  }),
);

/*
 * The JSON API's delete. A DELETE is a simple request a sibling site can send
 * with the session attached, so the origin check runs before anything is
 * removed. An unknown id and another account's id are the same 404, so the
 * endpoint cannot be used to discover which saved searches exist.
 */
const deleteSavedSearchApi = HttpRouter.route("DELETE", "/api/saved-searches/:id", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) {
      return HttpServerResponse.text(crossSiteFormMessage, { status: 403 });
    }

    const id = yield* Effect.map(HttpRouter.params, (params) =>
      decodeSavedSearchId(params["id"]),
    );
    if (id === undefined) {
      return HttpServerResponse.text("SavedSearchNotFoundError", { status: 404 });
    }

    const ownerId = yield* callerId;
    const savedSearchService = yield* SavedSearchService;
    const outcome = yield* Effect.result(savedSearchService.delete(ownerId, id));
    if (Result.isSuccess(outcome)) {
      return HttpServerResponse.empty({ status: 204 });
    }
    return outcome.failure._tag === "SavedSearchNotFoundError"
      ? HttpServerResponse.text("SavedSearchNotFoundError", { status: 404 })
      : HttpServerResponse.text("InternalError", { status: 500 });
  }),
);

// Exported as routes rather than a layer so the private router can register
// them next to its other pages under one auth middleware.
export const SavedSearchRoutes = [
  deleteSavedSearchApi,
  createSavedSearch,
  deleteSavedSearch,
];
