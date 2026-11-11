import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { Cookies } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { Effect, Option, Result, Schema } from "effect";

/*
 * The session a request's cookie pair proves, resolved once per request. A
 * private request gets it from `AuthMiddleware` before its route runs, and a
 * public page asks for it directly, so rotating a session lives here and no
 * route verifies an access token of its own. A stale access token with a live
 * refresh token therefore identifies the caller instead of hiding their own UI,
 * and the pair the session proves travels back for the response to carry. The
 * anonymous path is unchanged: a visitor with no live session is still just a
 * visitor, and nothing is minted.
 */
export interface OptionalCallerSession {
  readonly caller: Option.Option<typeof UserId.Type>;
  readonly cookies: ReadonlyArray<
    readonly [name: string, value: string, options?: Cookies.Cookie["options"]]
  >;
}

export type SessionResolver = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<OptionalCallerSession>;

const noCaller: OptionalCallerSession = { caller: Option.none(), cookies: [] };

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

      const outcome = yield* Effect.result(
        auth.tokenAuthFlow({ accessToken, refreshToken }, request.headers["user-agent"]),
      );
      if (Result.isFailure(outcome)) return noCaller;

      const { tokens, user } = outcome.success;
      const cookies: Array<readonly [string, string, Cookies.Cookie["options"]?]> = [];
      if (tokens.accessToken != null) {
        cookies.push(yield* jwtService.asCookie(tokens.accessToken));
      }
      if (tokens.refreshToken != null) {
        cookies.push(yield* refreshTokenService.asCookie(tokens.refreshToken));
      }
      return { caller: Option.some(user.id), cookies };
    });
});

export const optionalCaller = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<OptionalCallerSession, never, AuthService | JWTService | RefreshTokenService> =>
  Effect.flatMap(sessionResolver, (resolve) => resolve(request));
