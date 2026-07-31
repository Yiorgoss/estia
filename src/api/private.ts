import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpLayerRouter, HttpMiddleware, HttpPlatform, HttpServerResponse } from "@effect/platform";
import { Schema } from "effect";

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
  .prefix("/api")


export const PrivateRoutes = HttpLayerRouter.add(
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
