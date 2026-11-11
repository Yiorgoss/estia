import { PrivateApi } from "@/api/private";
import { callerId } from "@/handlers/private/caller";
import { SavedSearchService } from "@/services/saved-search.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

/*
 * The authenticated saved-search endpoints. The caller is the account the
 * session proves, so no request carries a user id: the list is only ever that
 * account's rows, and the service names an unnamed search after its criteria.
 */
export const SavedSearchHandler = HttpApiBuilder.group(
  PrivateApi,
  "saved-search-group",
  (handlers) =>
    handlers
      .handle("create", ({ payload, request }) =>
        Effect.gen(function* () {
          const ownerId = yield* callerId(request);
          const savedSearchService = yield* SavedSearchService;
          return yield* savedSearchService.create(ownerId, payload);
        }),
      )
      .handle("list", ({ request }) =>
        Effect.gen(function* () {
          const ownerId = yield* callerId(request);
          const savedSearchService = yield* SavedSearchService;
          return { items: yield* savedSearchService.list(ownerId) };
        }),
      ),
);
