import { JWTSchema, RefreshTokenValue } from "@/db/schema/brands";
import { signInRequiredPage } from "@/frontend/pages/sign-in-required";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Array, Effect, pipe, Schema } from "effect";
import { isNotNull } from "effect/Predicate";

/*
 * A request under `/api` is the JSON API, whose contract for a missing session
 * is a 401. Every other private route is a page, and a page answers a signed-out
 * visitor with a prompt carrying a sign-in link, never a bare error string.
 */
const unauthenticatedResponse = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.originalUrl).pathname.startsWith("/api/")
    ? HttpServerResponse.text("UnauthorizedError", { status: 401 })
    : HttpServerResponse.text(signInRequiredPage, { status: 401, contentType: "text/html" });

export const AuthMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const jwtService = yield* JWTService;
    const refreshTokenService = yield* RefreshTokenService;
    return (app) =>
      Effect.gen(function* () {
        const response = yield* app;

        yield* Effect.logInfo("Starting Auth Middleware");
        // Effect.fail(new UnauthorizedError)
        const request = yield* HttpServerRequest.HttpServerRequest;
        const userAgent = request.headers["user-agent"];

        const oldAccessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(
          request.cookies["access_token"],
        ).pipe(
          Effect.catchTags({
            SchemaError: () => Effect.succeed(null),
          }),
        );

        const oldRefreshToken = yield* Schema.decodeUnknownEffect(RefreshTokenValue)(
          request.cookies["refresh_token"],
        ).pipe(
          Effect.catchTags({
            SchemaError: () => Effect.succeed(null),
          }),
        );
        const { tokens, user } = yield* auth
          .tokenAuthFlow(
            {
              accessToken: oldAccessToken,
              refreshToken: oldRefreshToken,
            },
            userAgent,
          )
          .pipe(
            Effect.tapError((err) => {
              console.log(`console.log- ${err}`);
              return Effect.logInfo(`Error in Auth Middleware ${err}`);
            }),
            Effect.mapError(() => unauthenticatedResponse(request)),
          );

        if (!user) {
          return unauthenticatedResponse(request);
        }
        const newAccessCookie = yield* Effect.fromNullishOr(tokens.accessToken).pipe(
          Effect.matchEffect({
            onSuccess: (token) => jwtService.asCookie(token),
            onFailure: () => Effect.succeed(null),
          }),
        );
        const newRefreshCookie = yield* Effect.fromNullishOr(tokens.refreshToken).pipe(
          Effect.matchEffect({
            onSuccess: (token) => refreshTokenService.asCookie(token),
            onFailure: () => Effect.succeed(null),
          }),
        );

        const cookies = pipe([newAccessCookie, newRefreshCookie], Array.filter(isNotNull));

        return yield* HttpServerResponse.setCookies(response, cookies);
      });
  }),
).layer;
