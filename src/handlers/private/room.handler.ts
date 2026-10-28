import { PrivateApi } from "@/api/private";
import { RoomId } from "@/db/schema/brands";
import { RoomNotFoundError, RoomRepository } from "@/repo/room.repo";
import { InternalError } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect, Option, Schema } from "effect";

export const RoomHandler = HttpApiBuilder.group(PrivateApi, "room-group", (handlers) =>
  handlers
    // .handle("get-all-from", ({ params: { id } }) => Effect.gen(function* () {}))
    .handle("get-one", ({ params: { id } }) =>
      Effect.gen(function* () {
        const roomId = yield* Schema.decodeUnknownEffect(RoomId)(id);

        const roomRepo = yield* RoomRepository;
        return yield* roomRepo.findByRoomId(roomId).pipe(
          Effect.filterOrFail(
            Option.isSome,
            () => new RoomNotFoundError({ cause: "Room not found" }),
          ),
          Effect.map((x) => x.value),
        );
      }).pipe(
        Effect.catchTags({
          SchemaError: () => Effect.fail(new InternalError()),
          SqlError: () => Effect.fail(new InternalError()),
          RoomNotFoundError: (e) => Effect.fail(e),
        }),
      ),
    ),
);
