import { PublicApi } from "@/api/public";
import { head } from "@/frontend/head";
import { StorageRepository } from "@/repo/storage.repo";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { InternalError, UserService } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import { Effect, Stream } from "effect";

export const PublicApiLive = HttpApiBuilder.group(
  PublicApi,
  'auth',
  (handlers) =>
    handlers
      // .handle("test", (req) =>
      //   Effect.gen(function*() {

      //     const response = yield* HttpServerResponse.html(
      //       `
      //     <!doctype html>
      //     <html>
      //       <head>
      //         ${head}
      //       </head>
      //       <body class="flex place-content-center min-h-lvh">

      //         <div id='result' class="font-2xl" style='background:purple;width:500px;height:100px'>
      //           nothing yet
      //         </div>
      //         <form
      //           hx-post="/api/auth/test-post"
      //           enctype="multipart/form-data"
      //           hx-target="#result"
      //           hx-swap="outerHTML"
      //           name="files"
      //           >
      //             <input type='text' name="hi" />
      //             <input type='text' name="bye" />
      //             <button type='submit'>Submit</button>
      //         </form>
      //       </body>
      //     </html>
      //       `
      //     )
      //     return response
      //   }).pipe(
      //     // @effect-diagnostics-next-line catchUnfailableEffect:off
      //     Effect.catchAll(e => Effect.die(e))
      //   )
      // )
      .handle("test-post", ({ request }) =>
        Effect.gen(function*() {

          console.log("=========================================================================")

          const r2 = yield* StorageRepository
          yield* request.multipartStream.pipe(
            Stream.runForEach(part => Effect.gen(function*() {
              const { _tag, key } = part

              console.log({ _tag, key })
              if (_tag == 'File') {
                const r2Obj = yield* r2.newMultipart(`map/${key}`, part.content)
                console.log({ r2Obj })
              }
            })
            )
          )
          // yield* Effect.logInfo(formData['greece.pmtiles'])


          const response = HttpServerResponse.html(
            `<div id='result' style="background:tomato">Successful</div>`
          )

          return response
        }).pipe(
          Effect.catch(e => Effect.die(e))
        )
      )
      .handle('login', (req) =>
        Effect.gen(function*() {
          //validate user
          yield* Effect.logDebug("attempting login")
          const { email, password } = req.payload
          const userAgent = req.request.headers['user-agent']

          const authService = yield* AuthService
          const { accessToken, refreshToken } = yield* authService
            .authenticate({ email, password }, userAgent)
          yield* Effect.logInfo("authentication successful")
          const jwtService = yield* JWTService
          const accessCookie = yield* jwtService.asCookie(accessToken)
          const refreshTokenService = yield* RefreshTokenService
          const refreshCookie = yield* refreshTokenService.asCookie(refreshToken)


          return yield* HttpServerResponse.empty().pipe(
            HttpServerResponse.setStatus(200),
            HttpServerResponse.setCookies([
              accessCookie,
              refreshCookie
            ]),
            Effect.orDie
          )
        })
      )
      .handle('register', (req) =>
        Effect.gen(function*() {
          const { email, password } = req.payload
          const userAgent = req.request.headers['user-agent']

          const userService = yield* UserService
          const user = yield* userService
            .registerUser({ email, password }, userAgent)
          const authService = yield* AuthService
          const { accessToken, refreshToken } = yield* authService.authenticate({ email, password }, userAgent)

          return yield* HttpServerResponse.empty().pipe(
            HttpServerResponse.setStatus(200),
            HttpServerResponse.setCookies([
              ["access_token", accessToken,
                { httpOnly: true, secure: true, path: "/", maxAge: 60 * 60 * 1000 }
              ],
              ["refresh_token", refreshToken,
                { httpOnly: true, secure: true, path: "/", maxAge: 30 * 24 * 60 * 60 * 1000 }
              ]
            ]),
            Effect.orDie
          )
        }).pipe(Effect.mapError(() => new InternalError()))
      )
)
