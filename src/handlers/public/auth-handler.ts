import { PublicApi } from "@/api/public";
import { JWTSchema } from "@/brands";
import { AuthService } from "@/services/auth";
import { JWTService } from "@/services/jwt";
import { RefreshTokenService } from "@/services/refresh-token";
import { UserService } from "@/services/user";
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect, Schema } from "effect";


export const PublicApiLive = HttpApiBuilder.group(
  PublicApi,
  'auth',
  (handlers) =>
    handlers
      .handle("test", (req) =>
        Effect.gen(function*() {

          const response = yield* HttpServerResponse.html(
            ` <div class="bg-red-200">thisi s comingfrom  htmx!!</div>
              `
          ).pipe(
            HttpServerResponse.setCookie("jwt", "yyyyyyy", {
              httpOnly: true,
              secure: true,
              sameSite: "strict",
              path: "/",
              maxAge: 60 * 60 * 1000 //in ms 
            }),
            Effect.orDie
          )
          const reqCookie = req.request.cookies['access_token']
          console.log("cookies on request:", reqCookie)
          const jwtService = yield* JWTService
          const object = yield* jwtService
            .verify(Schema.decodeSync(JWTSchema)(reqCookie))
            .pipe(
              Effect.catchTags({
                InvalidJWTError: () => Effect.log("invalid"),
                ExpiredJWTError: () => Effect.log("expied")
              })
            )
          console.log("verified: ", object)
          return response ?? ""
        })
      )
      .handle('login', (req) =>
        Effect.gen(function*() {
          //validate user
          Effect.logDebug("attempting login")
          const { email, password } = req.payload
          const userAgent = req.request.headers['user-agent']

          const authService = yield* AuthService
          const { accessToken, refreshToken } = yield* authService
            .authenticate({ email, password }, userAgent)
          Effect.logInfo("authentication successful")
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
          const { accessToken, refreshToken } = yield* userService
            .registerUser({ email, password }, userAgent)

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
        })
      )
)
