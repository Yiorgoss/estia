import { UserLogin } from "../db/schema/User"
import { renderPage } from "@/frontend/render-page"
import { JWTSigningError, JWTValidateError } from "@/services/jwt"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpLayerRouter, HttpServerResponse } from "@effect/platform"
import { Effect, Schema } from "effect"



export const PublicApi = HttpApi.make('public')
  .add(
    HttpApiGroup
      .make('auth')
      .add(
        HttpApiEndpoint
          .post('login', '/login')
          // .addSuccess(User)
          .setPayload(UserLogin)
          .addError(JWTSigningError)
          .addError(JWTValidateError)
        // ).add(
        //   HttpApiEndpoint
        //     // delete the refresh token
        //     .get('logout', '/logout')
        //     .addSuccess(
        //       Schema.Struct({
        //         token: Schema.String,
        //         decode: Schema.Unknown
        //       })
        //     )
        // )
        // .add(
        //   HttpApiEndpoint
        //     .post('refresh', '/refresh')
        //     .addSuccess(
        //       Schema.Struct({
        //         token: Schema.String,
        //         decode: Schema.Unknown
        //       })
        //     )
      )
  )

export const PublicRoutes = HttpLayerRouter.addAll([
  HttpLayerRouter.route("GET", "/",
    Effect.succeed(
      HttpServerResponse.html(`
        <!doctype html>
        <html>
          <body>
            <h1>Hello!</h1>
          </body>
        </html>
      `)
    )
  ),
  HttpLayerRouter.route("GET", "/login",
    Effect.succeed(
      HttpServerResponse.html(renderPage())
    )
  )
])

