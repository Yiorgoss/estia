// NOTE: `RoomGroup` is currently commented out of `PrivateApi` (see
// `src/api/private.ts`), so this handler cannot be registered. It is kept here,
// commented out, because it is dead code. Re-enable it together with `RoomGroup`
// and the `RoomGroup` endpoint definitions.
/*
import { PrivateApi } from "@/api/private";
import { RoomId } from "@/db/schema/brands";
import { RoomNotFoundError, RoomRepository } from "@/repo/room.repo";
import { InternalError } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect, Option, Schema } from "effect";


export const RoomHandler = HttpApiBuilder.group(
  PrivateApi,
  'room-group',
  (handlers) =>
    handlers
      .handle("get-one", ({ path: { id } }) =>
        Effect.gen(function*() {
          const roomId = yield* Schema.decodeUnknownEffect(RoomId)(id)

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
            SchemaError: () => Effect.fail(new InternalError()),
            SqlError: () => Effect.fail(new InternalError()),
            RoomNotFoundError: (e) => Effect.fail(e),
          })
        )
      )
)
*/
