import { PublicApi } from "@/api/public";
import { RoomSearchService } from "@/services/room-search.service";
import { InternalError } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

export const RoomSearchHandler = HttpApiBuilder.group(PublicApi, "room-search", (handlers) =>
  handlers.handle("search", ({ query }) =>
    Effect.gen(function* () {
      const searchService = yield* RoomSearchService;
      return yield* searchService.search(query);
    }).pipe(Effect.catchTag("SqlError", () => Effect.fail(new InternalError()))),
  ),
);
