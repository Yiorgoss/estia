import { PrivateApi } from "@/api/private";
import { callerId } from "@/handlers/private/caller";
import { ListingService } from "@/services/listing.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

/*
 * The authenticated listing mutations. The caller is always the owner, so no
 * request carries an owner id: the cookie is the identity, and the service owns
 * the ownership, transition, and validation rules. Every error the service
 * raises already carries its HTTP status, so the handlers only wire the calls.
 */
export const ListingHandler = HttpApiBuilder.group(PrivateApi, "listing-group", (handlers) =>
  handlers
    .handle("create", ({ payload, request }) =>
      Effect.gen(function* () {
        const ownerId = yield* callerId(request);
        const listingService = yield* ListingService;
        return yield* listingService.createDraft(ownerId, payload);
      }),
    )
    .handle("update", ({ params, payload, request }) =>
      Effect.gen(function* () {
        const ownerId = yield* callerId(request);
        const listingService = yield* ListingService;
        return yield* listingService.updateListing(ownerId, params.id, payload);
      }),
    )
    .handle("publish", ({ params, request }) =>
      Effect.gen(function* () {
        const ownerId = yield* callerId(request);
        const listingService = yield* ListingService;
        return yield* listingService.publish(ownerId, params.id);
      }),
    )
    .handle("unlist", ({ params, request }) =>
      Effect.gen(function* () {
        const ownerId = yield* callerId(request);
        const listingService = yield* ListingService;
        return yield* listingService.unlist(ownerId, params.id);
      }),
    ),
);
