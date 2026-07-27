import { RefreshTokenValue } from "@/db/schema/RefreshToken";
import { CurrentUser, CurrentUserTag } from "@/db/schema/User";
import { AuthService, UnauthorizedError } from "@/services/auth";
import { JWTSchema, JWTService } from "@/services/jwt";
import { RefreshTokenService } from "@/services/refresh-token";
import { HttpApiMiddleware, HttpApiSecurity, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Layer, Schema, Redacted } from "effect";

export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    provides: CurrentUserTag,
    failure: UnauthorizedError
  }
) { }

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function*() {

    yield* Effect.logInfo("Starting Auth Middleware")
    const auth = yield* AuthService
    const jwtService = yield* JWTService
    const refreshTokenService = yield* RefreshTokenService

    const request = yield* HttpServerRequest.HttpServerRequest
    const userAgent = request.headers['user-agent']
    const accessToken = yield* Schema.decodeUnknown(JWTSchema)(request.cookies['access_token'])
    const refreshToken = yield* Schema.decodeUnknown(RefreshTokenValue)(request.cookies['refresh_token'])
    const { tokens, user } = yield* auth.tokenAuthFlow({ accessToken, refreshToken }, userAgent)

    const jwtCookie = yield* jwtService.asCookie(tokens.accessToken)
    const refreshTokenCookie = yield* refreshTokenService.asCookie(tokens.refreshToken)

    // yield* FiberRef.update(PendingCookies, (cs) => [
    //     ...cs,
    //     ["session", result.tokens.refreshToken, { httpOnly: true, secure: true, path: "/" }] as const
    //   ])

    //   return result.user
    // })
    return yield* HttpServerResponse.json().pipe(
      HttpServerResponse.setStatus(200),
      HttpServerResponse.setCookies([
        jwtCookie, refreshTokenCookie
      ]),
      Effect.orDie
    )
  })
)

// export const AuthMiddlewareLive = Layer.effect(
//   AuthMiddleware,
//   Effect.gen(function*() {
//     const jwtService = yield* JWTService
//     const refreshTokenService = yield* RefreshTokenService
//     return {
//       accessToken: (token: Redacted<string>) =>
//         Effect.gen(function*() {

//           const jwt = yield* jwtService
//             .verify(token)
//             .pipe(
//               Effect.catchTag("ExpiredJWTError", () => Effect.logInfo("ExpiredJWT -- refreshing"))
//             )
//           if (jwt) { return jwt }

//           const request = yield* HttpServerRequest.HttpServerRequest
//           const oldRefreshToken = Schema.decodeSync(RefreshTokenValue)
//             (request.cookies['refresh_token'])
//           const userAgent = request.headers['user-agent']


//           const { accessToken, refreshToken } = yield* refreshTokenService
//             .consumeToken(oldRefreshToken, userAgent)
//           const user = yield* jwtService.verify(Redacted.value(accessToken))
//           // return new CurrentUser({ id: 1, role: "admin" })

//           // return yield* HttpServerResponse.empty().pipe(
//           //   HttpServerResponse.setStatus(200),
//           //   HttpServerResponse.setCookies([
//           //     ["auth_token", accessToken,
//           //       { httpOnly: true, secure: true, path: "/", maxAge: 60 * 60 * 1000 }
//           //     ],
//           //     ["refresh_token", refreshToken,
//           //       { httpOnly: true, secure: true, path: "/", maxAge: 30 * 24 * 60 * 60 * 1000 }
//           //     ]
//           //   ]),
//           //   Effect.orDie
//           // )
//         })
//     }
//   })
// )
