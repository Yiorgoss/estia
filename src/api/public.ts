import { UserCredentials } from "@/db/schema/User"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpLayerRouter, HttpServerResponse } from "@effect/platform"
import { Effect, Layer, Schema } from "effect"
import { JWTSchema, JWTServiceLive } from "@/services/jwt"
import { InvalidCredentialsError } from "@/services/auth"
import { RefreshTokenValue } from "@/db/schema/RefreshToken"
import { InternalError, UserAlreadyExistsError, UserServiceLive } from "@/services/user"
import { loginPage } from "@/frontend/pages/login"
import { registerPage } from "@/frontend/pages/register"



export const PublicApi = HttpApi.make('public')
  .add(
    HttpApiGroup
      .make('auth')
      .add(
        HttpApiEndpoint
          .post('login', '/login')
          .addSuccess(
            Schema.Struct({
              accessToken: JWTSchema,
              refreshToken: RefreshTokenValue,
            }),
            { status: 200 }
          )
          .setPayload(UserCredentials)
          .addError(InvalidCredentialsError, { status: 401 })
          .addError(InternalError, { status: 500 })
      )
      .add(
        HttpApiEndpoint
          .post('register', '/register')
          .addSuccess(
            Schema.Struct({
              accessToken: JWTSchema,
              refreshToken: RefreshTokenValue,
            }),
            { status: 200 }
          )
          .setPayload(UserCredentials)
          .addError(UserAlreadyExistsError, { status: 409 })
          .addError(InternalError, { status: 500 })
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
      HttpServerResponse.html(loginPage)
    )
  ),
  HttpLayerRouter.route("GET", "/register",
    Effect.succeed(
      HttpServerResponse.html(registerPage)
    )
  )
])

