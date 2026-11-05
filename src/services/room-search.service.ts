import { RoomSchema, RoomSearchFilters } from "@/db/schema/Room";
import { RoomRepository } from "@/repos/room.repo";
import type { SqlError } from "effect/sql/SqlError";
import { Context, Effect, Layer } from "effect";

export interface RoomSearchService {
  readonly search: (
    filters: typeof RoomSearchFilters.Type,
  ) => Effect.Effect<ReadonlyArray<typeof RoomSchema.Type>, SqlError>;
}

export const RoomSearchService = Context.Service<RoomSearchService>("RoomSearchService");

export const RoomSearchServiceLive = Layer.effect(
  RoomSearchService,
  Effect.gen(function* () {
    const roomRepo = yield* RoomRepository;
    return {
      search: (filters) => roomRepo.search(filters),
    } satisfies RoomSearchService;
  }),
);
