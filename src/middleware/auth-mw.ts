import { JWTSchema, RefreshTokenValue } from "@/brands";
import { AuthService } from "@/services/auth";
import { JWTService, } from "@/services/jwt";
import { RefreshTokenService } from "@/services/refresh-token";
import { HttpLayerRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Array, Effect, pipe, Schema } from "effect";
import { isNotNull } from "effect/Predicate";


export const AuthMiddleware = HttpLayerRouter.middleware(
  Effect.gen(function*() {

    const auth = yield* AuthService
    const jwtService = yield* JWTService
    const refreshTokenService = yield* RefreshTokenService
    return (app) =>
      Effect.gen(function*() {
        const response = yield* app

        yield* Effect.logInfo("Starting Auth Middleware")
        // Effect.fail(new UnauthorizedError)
        const request = yield* HttpServerRequest.HttpServerRequest
        const userAgent = request.headers['user-agent']


        const oldAccessToken = yield* Schema.decodeUnknown(JWTSchema)
          (request.cookies['access_token']).pipe(
            Effect.catchTags({
              ParseError: () => Effect.succeed(null)
            })
          )

        const oldRefreshToken = yield* Schema.decodeUnknown(RefreshTokenValue)
          (request.cookies['refresh_token']).pipe(
            Effect.catchTags({
              ParseError: () => Effect.succeed(null)
            })
          )


        const { tokens, user } = yield* auth.tokenAuthFlow({
          accessToken: oldAccessToken,
          refreshToken: oldRefreshToken
        }, userAgent)
          .pipe(
            Effect.tapError((err) => {
              console.log(`console.log- ${err}`)
              return Effect.logInfo(`Error in Auth Middleware ${err}`)
            }),
            Effect.mapError(() =>
              HttpServerResponse.text("UnauthorizedError", { status: 401 })
            )
          )

        if (!user) {
          return HttpServerResponse.text("UnauthorizedError", { status: 401 })
        }


        const newAccessCookie = yield* Effect.fromNullable(tokens.accessToken)
          .pipe(
            Effect.matchEffect({
              onSuccess: (token) => jwtService.asCookie(token),
              onFailure: () => Effect.succeed(null)
            })
          )
        const newRefreshCookie = yield* Effect.fromNullable(tokens.refreshToken)
          .pipe(
            Effect.matchEffect({
              onSuccess: (token) => refreshTokenService.asCookie(token),
              onFailure: () => Effect.succeed(null)
            }),
          )

        const cookies = pipe(
          [newAccessCookie, newRefreshCookie],
          Array.filter(isNotNull),
        )
        console.log({ cookies })

        return yield* HttpServerResponse.setCookies(response, cookies)
      })
  })
).layer
