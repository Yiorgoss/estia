import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { Cookies, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { Effect, Result, Schema } from "effect";

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
 * leave one of them holding a token the other just spent. That is not an
 * anonymous visit: the session is live and the winner's pair is on its way, so
 * the loser asks the browser to retry with it. Only a token that was never seen,
 * or was spent long enough ago that no request can still be carrying it, is
 * answered as anonymous.
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

      const outcome = yield* Effect.result(
        auth.tokenAuthFlow({ accessToken, refreshToken }, request.headers["user-agent"]),
      );
      if (Result.isFailure(outcome)) {
        if (refreshToken !== null && (yield* refreshTokenService.justRotated(refreshToken))) {
          return retry;
        }
        return anonymous;
      }

      const { tokens, user } = outcome.success;
      const cookies: Array<readonly [string, string, Cookies.Cookie["options"]?]> = [];
      if (tokens.accessToken != null) {
        cookies.push(yield* jwtService.asCookie(tokens.accessToken));
      }
      if (tokens.refreshToken != null) {
        cookies.push(yield* refreshTokenService.asCookie(tokens.refreshToken));
      }
      return { _tag: "caller", caller: user.id, cookies };
    });
});

export const optionalCaller = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<OptionalCallerSession, never, AuthService | JWTService | RefreshTokenService> =>
  Effect.flatMap(sessionResolver, (resolve) => resolve(request));

/*
 * The answer to a request that lost the rotation race: htmx reloads the page and
 * a browser navigation replays the request, both with the winner's pair once its
 * response lands. The JSON API has no page to reload, so it keeps the 401 its
 * callers already handle. A stale pair only reaches here inside the rotation
 * window, so a session that is really gone falls through to the anonymous page.
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
  return HttpServerResponse.redirect(`${url.pathname}${url.search}`, { status: 307 });
};
