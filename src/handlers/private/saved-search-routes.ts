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
import { withMinorUnitPrices } from "@/utils";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  UrlParams,
} from "effect/http";
import { Effect, Option, Result, Schema } from "effect";

/*
 * The browser paths for saved searches. They live on the private router, so
 * `AuthMiddleware` gates them and `callerId` names the account; every write also
 * passes the shared origin check, because a sibling site can post these forms
 * with the session attached.
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

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

const panelError = "Your saved searches could not be loaded just now.";

/*
 * The list as the page shows it, with an optional banner. An htmx request gets
 * the section it targets; a request without htmx is a navigation, and every
 * answer to one - saved, refused, or failed - is the search page rather than a
 * bare fragment. A failed read is rendered inside the section, so the
 * surrounding search page stays usable.
 */
const panelFor = (
  request: HttpServerRequest.HttpServerRequest,
  ownerId: typeof UserId.Type,
  options: SavedSearchesPanelOptions = {},
  extra = "",
) =>
  Effect.gen(function* () {
    if (!isHtmx(request)) return seeOther("/search");
    const savedSearchService = yield* SavedSearchService;
    const listed = yield* Effect.result(savedSearchService.list(ownerId));
    if (Result.isFailure(listed)) {
      return respond(savedSearchesPanel([], { error: panelError }), 200);
    }
    return respond(`${savedSearchesPanel(listed.success, options)}${extra}`, 200);
  });

/*
 * htmx only swaps 2xx responses, so a refused htmx save or delete has to answer
 * the list section with a 200 and the error banner; a 4xx would leave the old
 * list in place and the person would see nothing happen. The banner rides on the
 * stored rows, because a refused write must not look like an empty list. A
 * request without htmx is a navigation and keeps the status that describes it.
 */
const refuse = (
  request: HttpServerRequest.HttpServerRequest,
  ownerId: typeof UserId.Type,
  message: string,
) =>
  isHtmx(request)
    ? panelFor(request, ownerId, { error: message })
    : Effect.succeed(respond(message, 403));

/*
 * Saving from the search page. The form's own field is the optional name; the
 * criteria arrive from the search form through `hx-include`, so the server reads
 * the same query parameters the results route reads and no criteria is trusted
 * from a hidden field. A blank name is left to the service, which names the
 * search after its criteria.
 */
const createSavedSearch = HttpRouter.route("POST", "/search/saved", (request) =>
  Effect.gen(function* () {
    const ownerId = yield* callerId;
    if (!isSameOriginWrite(request)) {
      return yield* refuse(request, ownerId, crossSiteFormMessage);
    }

    const params = yield* readForm(request);
    const { name: rawName, ...rawCriteria } = params;

    const nameCandidate =
      typeof rawName === "string" && rawName.trim() === "" ? undefined : rawName;
    const name =
      typeof nameCandidate === "string"
        ? Option.getOrUndefined(Schema.decodeUnknownOption(SavedSearchName)(nameCandidate))
        : undefined;
    if (typeof nameCandidate === "string" && name === undefined) {
      return yield* panelFor(request, ownerId, {
        error: "That name could not be used. Use 120 characters or fewer.",
      });
    }

    const decoded = Schema.decodeUnknownResult(ListingSearchQueryCodec)(
      withMinorUnitPrices(rawCriteria),
    );
    if (Result.isFailure(decoded)) {
      return yield* panelFor(request, ownerId, { error: "Those filters could not be read." });
    }

    const { limit: _limit, cursor: _cursor, ...criteria } = decoded.success;
    const savedSearchService = yield* SavedSearchService;
    const created = yield* Effect.result(
      savedSearchService.create(ownerId, { name, ...criteria }),
    );
    if (Result.isFailure(created)) {
      return yield* panelFor(request, ownerId, {
        error: "This search could not be saved just now. Please try again.",
      });
    }

    return yield* panelFor(
      request,
      ownerId,
      { notice: `Saved: ${created.success.name}` },
      clearedNameInput(),
    );
  }),
);

const deleteSavedSearch = HttpRouter.route("POST", "/search/saved/:id/delete", (request) =>
  Effect.gen(function* () {
    const ownerId = yield* callerId;
    if (!isSameOriginWrite(request)) {
      return yield* refuse(request, ownerId, crossSiteFormMessage);
    }

    const id = yield* Effect.map(HttpRouter.params, (params) =>
      decodeSavedSearchId(params["id"]),
    );
    if (id === undefined) {
      return yield* panelFor(request, ownerId, {
        error: "That saved search no longer exists.",
      });
    }

    const savedSearchService = yield* SavedSearchService;
    const outcome = yield* Effect.result(savedSearchService.delete(ownerId, id));
    if (Result.isFailure(outcome)) {
      const error =
        outcome.failure._tag === "SavedSearchNotFoundError"
          ? "That saved search no longer exists."
          : "This saved search could not be deleted just now. Please try again.";
      return yield* panelFor(request, ownerId, { error });
    }

    return yield* panelFor(request, ownerId, { notice: "Saved search deleted." });
  }),
);

// Exported as routes rather than a layer so the private router can register
// them next to its other pages under one auth middleware.
export const SavedSearchRoutes = [
  createSavedSearch,
  deleteSavedSearch,
];
