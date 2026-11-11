import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { Cookies } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { Effect, Option, Result, Schema } from "effect";

/*
 * The caller a public page can identify, for the parts of the page that belong
 * to the signed-in visitor: the saved-search list, the save control, and the
 * search a `?saved=` link applies. A public GET is not behind `AuthMiddleware`,
 * so the session is rotated here with the same `tokenAuthFlow` the middleware
 * uses. A stale access token with a live refresh token therefore identifies the
 * caller instead of hiding their own UI, and the rotated pair travels back for
 * the response to persist. The anonymous path is unchanged: a visitor with no
 * live session is still just a visitor, and nothing is minted.
 */
export interface OptionalCallerSession {
  readonly caller: Option.Option<typeof UserId.Type>;
  readonly cookies: ReadonlyArray<
    readonly [name: string, value: string, options?: Cookies.Cookie["options"]]
  >;
}

const noCaller: OptionalCallerSession = { caller: Option.none(), cookies: [] };

export const optionalCaller = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<OptionalCallerSession, never, AuthService | JWTService | RefreshTokenService> =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const jwtService = yield* JWTService;
    const refreshTokenService = yield* RefreshTokenService;

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
    const caller = Option.some(user.id);
    // `tokenAuthFlow` hands a live access token back unchanged; only a rotation
    // has a new pair to write back, so an ordinary page load sets no cookies.
    if (tokens.accessToken === accessToken) return { caller, cookies: [] };

    const cookies: Array<readonly [string, string, Cookies.Cookie["options"]?]> = [];
    if (tokens.accessToken != null) {
      cookies.push(yield* jwtService.asCookie(tokens.accessToken));
    }
    if (tokens.refreshToken != null) {
      cookies.push(yield* refreshTokenService.asCookie(tokens.refreshToken));
    }
    return { caller, cookies };
  });
