import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { Cookies, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { Effect, Schema } from "effect";

/*
 * The session a request's cookie pair proves, resolved once per request. A
 * private request gets it from `AuthMiddleware` before its route runs, and a
 * public page asks for it directly, so rotating a session lives here and no
 * route verifies an access token of its own. A stale access token with a live
 * refresh token therefore identifies the caller instead of hiding their own UI,
 * and the pair the session proves travels back for the response to carry. A
 * request carrying no session cookie never reaches the auth flow, so an ordinary
 * public page load is not an auth event.
 *
 * Rotation is single-use, so two overlapping requests carrying the same pair
 * leave one of them holding a token the other just spent. The loser is told to
 * retry with the winner's pair, but only when its own rotation lost that race: a
 * request that never proved the token was live, or found it already spent, is an
 * anonymous visit and never retries.
 */
export type OptionalCallerSession =
  | {
      readonly _tag: "caller";
      readonly caller: typeof UserId.Type;
      readonly cookies: ReadonlyArray<
        readonly [name: string, value: string, options?: Cookies.Cookie["options"]]
      >;
    }
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "retry" };

export type SessionResolver = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<OptionalCallerSession>;

const anonymous: OptionalCallerSession = { _tag: "anonymous" };
const retry: OptionalCallerSession = { _tag: "retry" };

// Built once by a caller that already holds the services, so resolving a
// request needs nothing from the request context.
export const sessionResolver: Effect.Effect<
  SessionResolver,
  never,
  AuthService | JWTService | RefreshTokenService
> = Effect.gen(function* () {
  const auth = yield* AuthService;
  const jwtService = yield* JWTService;
  const refreshTokenService = yield* RefreshTokenService;

  return (request) =>
    Effect.gen(function* () {
      const accessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(
        request.cookies["access_token"],
      ).pipe(Effect.catchTags({ SchemaError: () => Effect.succeed(null) }));
      const refreshToken = yield* Schema.decodeUnknownEffect(RefreshTokenValue)(
        request.cookies["refresh_token"],
      ).pipe(Effect.catchTags({ SchemaError: () => Effect.succeed(null) }));

      if (accessToken === null && refreshToken === null) return anonymous;

      return yield* auth
        .tokenAuthFlow({ accessToken, refreshToken }, request.headers["user-agent"])
        .pipe(
          Effect.flatMap(({ tokens, user }) =>
            Effect.gen(function* () {
              const cookies: Array<readonly [string, string, Cookies.Cookie["options"]?]> = [];
              if (tokens.accessToken != null) {
                cookies.push(yield* jwtService.asCookie(tokens.accessToken));
              }
              if (tokens.refreshToken != null) {
                cookies.push(yield* refreshTokenService.asCookie(tokens.refreshToken));
              }
              return { _tag: "caller", caller: user.id, cookies } as const;
            }),
          ),
          Effect.catchTags({
            // The token was live when this request consumed it and spent when
            // it tried to rotate it: another request rotated it in between.
            RefreshTokenRotatedError: () => Effect.succeed(retry),
            InvalidJWTError: () => Effect.succeed(anonymous),
            ExpiredJWTError: () => Effect.succeed(anonymous),
            UnauthorizedError: () => Effect.succeed(anonymous),
            UserNotFoundError: () => Effect.succeed(anonymous),
            RefreshTokenNotFoundError: () => Effect.succeed(anonymous),
            InternalError: () => Effect.succeed(anonymous),
          }),
        );
    });
});

export const optionalCaller = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<OptionalCallerSession, never, AuthService | JWTService | RefreshTokenService> =>
  Effect.flatMap(sessionResolver, (resolve) => resolve(request));

/*
 * The answer to a request that lost the rotation race: htmx reloads the page and
 * a browser navigation lands on a page that exists, both with the winner's pair
 * once its response lands. Only a GET can replay its own URL; a state-changing
 * POST has no GET route of its own, so it is sent to the search page instead of
 * the router's 404. The JSON API has no page to reload, so it keeps the 401 its
 * callers already handle. The race is detected at the rotation itself, so a
 * retry with the spent pair is answered as anonymous instead of looping.
 */
export const retrySessionResponse = (
  request: HttpServerRequest.HttpServerRequest,
): HttpServerResponse.HttpServerResponse => {
  if (request.headers["hx-request"] === "true") {
    return HttpServerResponse.empty({ status: 200, headers: { "HX-Refresh": "true" } });
  }
  const url = new URL(request.originalUrl);
  if (url.pathname.startsWith("/api/")) {
    return HttpServerResponse.text("UnauthorizedError", { status: 401 });
  }
  const target =
    request.method === "GET" || request.method === "HEAD"
      ? `${url.pathname}${url.search}`
      : "/search";
  return HttpServerResponse.redirect(target, { status: 303 });
};
