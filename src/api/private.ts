import { AuthMiddleware } from "@/middleware/auth-mw";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpLayerRouter, HttpPlatform, HttpServerResponse, Path } from "@effect/platform";
import { Effect, Schema } from "effect";

const PrivateGroup = HttpApiGroup
  .make('private')
  .add(
    HttpApiEndpoint
      .get("private-test", "/private-test")
      .addSuccess(Schema.String)
  ).prefix("/private")

export const PrivateApi = HttpApi
  .make('private')
  .add(PrivateGroup)
  // .middleware(AuthMiddleware)
  .prefix("/api")

export const PrivateRoutes = HttpLayerRouter.addAll([
  HttpLayerRouter.route("GET", "/private-get",
    Effect.succeed(
      HttpServerResponse.html(`
        <!doctype html>
        <html>
          <body>
            <h1>Hello Protected!</h1>
          </body>
        </html>
      `)
    )
  ),
])

