import { PublicApi } from "@/api/public";
import { ListingService } from "@/services/listing.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

export const ListingSearchHandler = HttpApiBuilder.group(PublicApi, "listings", (handlers) =>
  handlers.handle("search", ({ query }) =>
    Effect.gen(function* () {
      const listingService = yield* ListingService;
      // The query schema decodes the wire form into the model's own filters and
      // page request; the service owns the visibility, ordering, and limit
      // rules, so the handler only splits them apart.
      const { limit, cursor, ...filters } = query;
      return yield* listingService.search(filters, { limit, cursor });
    }),
  ),
);
