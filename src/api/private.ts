import { ListerSchema } from "@/db/schema/Lister";
import { RoomSchema } from "@/db/schema/Room";
import { SeekerSchema } from "@/db/schema/Seeker";
import { CurrentUser } from "@/db/schema/User";
import { RoomNotFoundError } from "@/repo/room.repo";
import { UnauthorizedError } from "@/services/auth.service";
import { InternalError } from "@/services/user.service";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Schema } from "effect";

export const UserGroup = HttpApiGroup
  .make('user-group')
  .add(
    HttpApiEndpoint
      .get("me", "/me", {
        success: Schema.Struct({
          user: CurrentUser,
          userProfile: Schema.Union([SeekerSchema, ListerSchema])
        }),
        error: [
          InternalError,
          UnauthorizedError,
        ],
      })
  )
  .add(
    HttpApiEndpoint
      .post("change-role", "/change-role", {
        success: Schema.Struct({
          newProfile: Schema.Union([SeekerSchema, ListerSchema])
        }),
        error: [
          InternalError,
          UnauthorizedError,
        ],
      })
  )
  .prefix("/users")

// export const RoomGroup = HttpApiGroup
//   .make('room-group')
//   .add(
//     HttpApiEndpoint
//       .get("get-one", "/:id")
//       .setPath(
//         Schema.Struct({
//           id: Schema.NumberFromString
//         })
//       )
//       .addSuccess(RoomSchema)
//       .addError(InternalError)
//       .addError(RoomNotFoundError, { status: 404 })
//   )
//   .prefix("/rooms")

export const PrivateApi = HttpApi
  .make('private-api')
  .add(UserGroup)
  // .add(RoomGroup)
  .prefix("/api")


export const PrivateRoutes = HttpRouter.add(
  "GET",
  "/private-get",
  HttpServerResponse.html(`
        <!doctype html>
        <html>
          <body>
            <h1>Hello Protected!</h1>
          </body>
        </html>
      `)
)
