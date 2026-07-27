import { UserCredentials } from "@/db/schema/User"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpLayerRouter, HttpServerResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import { JWTSchema } from "@/services/jwt"
import { InvalidCredentialsError, UnauthorizedError } from "@/services/auth"
import { RefreshTokenValue } from "@/db/schema/RefreshToken"
import { InternalError, UserAlreadyExistsError } from "@/services/user"
import { loginPage } from "@/frontend/pages/login"
import { registerPage } from "@/frontend/pages/register"


const AuthGroup = HttpApiGroup
  .make('auth')
  .add(
    HttpApiEndpoint
      // .post("test", "/test")
      .get("test", "/test")
      .addSuccess(Schema.String)
  )
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
      .addError(UnauthorizedError, { status: 401 })
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
  ).prefix("/auth")

export const PublicApi = HttpApi
  .make('public')
  .add(AuthGroup)
  .prefix("/api")

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

