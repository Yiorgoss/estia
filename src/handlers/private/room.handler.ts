import { PrivateApi } from "@/api/private";
import { JWTSchema, RoomId } from "@/db/schema/brands";
import { RoomNotFoundError, RoomRepository } from "@/repo/room.repo";
import { InternalError } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect, Option, Schema } from "effect";
import { JWTService } from "@/services/jwt.service";
import { ListerRepository } from "@/repo/lister.repo";
import { UnauthorizedError } from "@/services/auth.service";
import { CreateRoomSchema } from "@/db/schema/Room";

export const RoomHandler = HttpApiBuilder.group(PrivateApi, "room-group", (handlers) =>
  handlers
    // .handle("get-all-from", ({ params: { id } }) => Effect.gen(function* () {}))
    .handle("create", ({ request, payload }) =>
      Effect.gen(function* () {
        const jwtService = yield* JWTService;
        const accessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(
          request.cookies["access_token"],
        );
        const userJWT = yield* jwtService.verify(accessToken);
        const user = yield* jwtService.extractUser(userJWT);

        const listerRepo = yield* ListerRepository;
        //lister doesnt exist => unauthorized
        const { id } = yield* listerRepo
          .findByUserId(user.id)
          .pipe(Effect.map(Option.getOrThrowWith(() => new UnauthorizedError())));
        const createRoom = { ...payload, listerId: id };
        const newRoomBody = yield* Schema.decodeUnknownEffect(CreateRoomSchema)(createRoom);

        const roomRepo = yield* RoomRepository;

        return yield* roomRepo
          .insertRoom(newRoomBody)
          .pipe(Effect.map(Option.getOrThrowWith(() => new UnauthorizedError())));
      }).pipe(
        Effect.catchTags({
          ExpiredJWTError: () => Effect.fail(new UnauthorizedError()),
          SchemaError: () => Effect.fail(new InternalError()),
          InvalidJWTError: () => Effect.fail(new InternalError()),
          SqlError: () => Effect.fail(new InternalError()),
        }),
      ),
    )
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
