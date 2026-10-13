import { UserCredentials } from "@/db/schema/User"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Effect, Schema } from "effect"
import { InvalidCredentialsError, UnauthorizedError } from "@/services/auth.service"
import { InternalError, UserAlreadyExistsError } from "@/services/user.service"
import { loginPage } from "@/frontend/pages/login"
import { registerPage } from "@/frontend/pages/register"
import { mapDemo } from "@/frontend/map-demo"
import { JWTSchema, RefreshTokenValue } from "@/db/schema/brands"
import { head } from "@/frontend/head"


const AuthGroup = HttpApiGroup
  .make('auth')
  .add(
    HttpApiEndpoint
      .post("test-post", "/test-post")
  )
  .add(
    HttpApiEndpoint
      .post('login', '/login', {
        payload: UserCredentials,
        success: Schema.Struct({
          accessToken: JWTSchema,
          refreshToken: RefreshTokenValue,
        }),
        error: [
          InvalidCredentialsError,
          UnauthorizedError,
          InternalError,
        ],
      })
  )
  .add(
    HttpApiEndpoint
      .post('register', '/register', {
        payload: UserCredentials,
        success: Schema.Struct({
          accessToken: JWTSchema,
          refreshToken: RefreshTokenValue,
        }),
        error: [
          UserAlreadyExistsError.pipe(HttpApiSchema.status(409)),
          InternalError,
        ],
      })
  ).prefix("/auth")

export const PublicApi = HttpApi
  .make('public')
  .add(AuthGroup)
  .prefix("/api")

export const PublicRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/",
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
  HttpRouter.route("GET", "/login",
    Effect.succeed(
      HttpServerResponse.html(loginPage)
    )
  ),
  HttpRouter.route("GET", "/register",
    Effect.succeed(
      HttpServerResponse.html(registerPage)
    )
  ),
  HttpRouter.route("GET", "/map",
    Effect.succeed(
      HttpServerResponse.html(mapDemo)
    )),
  HttpRouter.route("GET", "/test",
    Effect.succeed(
      HttpServerResponse.html(
        `
          <!doctype html>
          <html>
            <head>
              ${head}
            </head>
            <body class="flex bg-gray-200 place-content-center min-h-lvh">
            
              <div id='result' class="font-2xl" style='background:purple;width:500px;height:100px'>
                nothing yet
              </div>
              <form
                hx-post="/api/auth/test-post"
                enctype="multipart/form-data"
                hx-target="#result"
                hx-swap="outerHTML"
                name="files"
                >
                  <input type='text' name="hi" />
                  <input type='file' name="file" />
                  <button type='submit'>Submit</button>
              </form>
            </body>
          </html>
            `
      )
    ))
])
