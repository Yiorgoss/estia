import { PrivateApi } from "@/api/private";
import { RoomId, UserId } from "@/db/schema/brands";
import { RoomNotFoundError, RoomRepository } from "@/repo/room.repo";
import { InternalError } from "@/services/user.service";
import { HttpApiBuilder } from "@effect/platform";
import { Effect, Option, Schema } from "effect";


export const RoomHandler = HttpApiBuilder.group(
  PrivateApi,
  'room-group',
  (handlers) =>
    handlers
      .handle("get-one", ({ path: { id } }) =>
        Effect.gen(function*() {
          const roomId = yield* Schema.decodeUnknown(RoomId)(id)

          const roomRepo = yield* RoomRepository
          return yield* roomRepo
            .findByRoomId(roomId)
            .pipe(
              Effect.filterOrFail(
                Option.isSome,
                () => new RoomNotFoundError({ cause: "" })
              ),
              Effect.map(x => x.value)
            )
        }).pipe(
          Effect.catchTags({
            ParseError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
            SqlError: (e) => Effect.fail(new InternalError({ cause: e._tag })),
            RoomNotFoundError: (e) => Effect.fail(e),
          })
        )
      )
)
