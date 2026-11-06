import { ListerSchema } from "@/db/schema/Lister";
import { CreateRoomBodySchema, RoomSchema } from "@/db/schema/Room";
import { SeekerSchema } from "@/db/schema/Seeker";
import { CurrentUser } from "@/db/schema/User";
import { RoomNotFoundError } from "@/repos/room.repo";
import { UnauthorizedError } from "@/services/auth.service";
import { InternalError } from "@/services/user.service";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Schema } from "effect";
import { createRoom } from "@/frontend/pages/create-room";
import { BadRequest } from "effect/http-api/HttpApiError";

export const UserGroup = HttpApiGroup.make("user-group")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: Schema.Struct({
        user: CurrentUser,
        userProfile: Schema.Union([SeekerSchema, ListerSchema]),
      }),
      error: [InternalError, UnauthorizedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("change-role", "/change-role", {
      success: Schema.Struct({
        newProfile: Schema.Union([SeekerSchema, ListerSchema]),
      }),
      error: [InternalError, UnauthorizedError],
    }),
  )
  // A group prefix only applies to the endpoints added before it.
  .prefix("/users");

export const RoomGroup = HttpApiGroup.make("room-group")
  .add(
    HttpApiEndpoint.post("create", "/create", {
      payload: CreateRoomBodySchema,
      success: RoomSchema.pipe(HttpApiSchema.status("Created")),
      error: [UnauthorizedError, InternalError, BadRequest],
    }),
  )
  .add(
    HttpApiEndpoint.get("get-one", "/:id", {
      params: Schema.Struct({
        id: Schema.NumberFromString,
      }),
      success: RoomSchema,
      error: [InternalError, RoomNotFoundError],
    }),
  )
  // A group prefix only applies to the endpoints added before it.
  .prefix("/rooms");

// The api prefix only applies to the groups added before it.
export const PrivateApi = HttpApi.make("private-api").add(UserGroup).add(RoomGroup).prefix("/api");

export const PrivateRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/private-get",
    HttpServerResponse.html(`
        <!doctype html>
        <html>
          <body>
            <h1>Hello Protected!</h1>
          </body>
        </html>
      `),
  ),
  HttpRouter.route("GET", "/create-room", HttpServerResponse.html(createRoom)),
]);
