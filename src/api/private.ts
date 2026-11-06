import { ListerSchema } from "@/db/schema/Lister";
import { SeekerSchema } from "@/db/schema/Seeker";
import { CurrentUser } from "@/db/schema/User";
import { UnauthorizedError } from "@/services/auth.service";
import { InternalError } from "@/services/user.service";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Schema } from "effect";

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

// The api prefix only applies to the groups added before it.
export const PrivateApi = HttpApi.make("private-api").add(UserGroup).prefix("/api");

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
]);
