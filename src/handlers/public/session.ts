import { JWTSchema, RefreshTokenValue } from "@/db/schema/brands";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Effect, Option, Result, Schema } from "effect";

/*
 * The ends of a session, and a deliberate renewal of one. These routes are
 * public: they are authenticated by the cookies the caller presents, never by an
 * authorization header, so a person whose access cookie has already expired can
 * still sign out or refresh. None of them is behind `AuthMiddleware`, because
 * that middleware answers a missing session with a 401 instead of doing what
 * these routes exist to do - and because its post-response rotation would hand a
 * signed-out-everywhere caller a fresh refresh token.
 *
 * The token format, the cookie names, and the lifetimes are the ones the app
 * already issues; nothing here mints a new kind of session.
 */

/*
 * A browser submitting the log-out form is navigating and asks for HTML, so it
 * gets a redirect to the sign-in page. A script or API client gets an empty 204,
 * which is the answer that carries the cleared cookies without pretending to
 * have a page to show.
 */
const prefersHtml = (request: HttpServerRequest.HttpServerRequest): boolean => {
  if (request.headers["sec-fetch-mode"] === "navigate") return true;
  const accept = (request.headers["accept"] ?? "").toLowerCase();
  if (accept.includes("application/json")) return false;
  return accept.includes("text/html");
};

// The caller's refresh cookie, read the way the middleware reads it: a missing
// value, and a value the brand refuses to decode, are both simply no refresh
// token. A garbage value is then signed out harmlessly instead of failing, and
// any refinement added to `RefreshTokenValue` later applies here for free.
const cookieRefreshToken = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Option.Option<typeof RefreshTokenValue.Type>> =>
  Effect.gen(function* () {
    const raw = request.cookies["refresh_token"];
    if (raw === undefined) return Option.none();
    const decoded = yield* Effect.result(Schema.decodeUnknownEffect(RefreshTokenValue)(raw));
    return Result.isSuccess(decoded) ? Option.some(decoded.success) : Option.none();
  });

// Every refusal on the refresh route is one answer. A revoked, expired, replayed,
// or missing token must not teach the caller which case it was, so none of them
// sets a cookie or says anything else.
const unauthorized = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("UnauthorizedError", { status: 401 });

/*
 * Signing out keys on the refresh token, never on the access token: the access
 * cookie is short-lived and may already have expired by the time the person
 * clicks log out, while the refresh token is the month-long credential that
 * actually has to die.
 *
 * Clearing the cookies is the promise this route makes, so it happens even when
 * the row cannot be revoked; a database failure is logged, and the person still
 * ends up signed out of this device rather than stuck with a working token.
 */
const logout = HttpRouter.route("POST", "/api/auth/logout", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) {
      return HttpServerResponse.text(crossSiteFormMessage, { status: 403 });
    }

    const refreshTokenService = yield* RefreshTokenService;
    const jwtService = yield* JWTService;

    const presented = yield* cookieRefreshToken(request);
    if (Option.isSome(presented)) {
      yield* refreshTokenService
        .revokeToken(presented.value)
        .pipe(
          Effect.catchTag("InternalError", (error) =>
            Effect.logError("Signing out could not revoke the refresh token", { error }),
          ),
        );
    }

    const response = prefersHtml(request)
      ? HttpServerResponse.redirect("/login", { status: 303 })
      : HttpServerResponse.empty({ status: 204 });

    return yield* HttpServerResponse.setCookies(response, [
      yield* jwtService.clearCookie(),
      yield* refreshTokenService.clearCookie(),
    ]).pipe(Effect.orDie);
  }),
);

/*
 * A deliberate renewal. The rotation is the middleware's own flow, run with no
 * access token: consume the refresh token, sign a fresh access token for the
 * account it belongs to, rotate the refresh token. Restating the rotation here
 * would give the app two of them to keep in step, so there is only ever the one
 * in `AuthService.tokenAuthFlow`.
 *
 * The caller gets the new pair in the response cookies and the current user
 * summary in the body. A token that cannot be consumed - revoked, expired,
 * replayed, or missing - answers 401 and sets nothing.
 */
const refresh = HttpRouter.route("POST", "/api/auth/refresh", (request) =>
  Effect.gen(function* () {
    // Rotating a credential is a write, and a foreign page can post this as a
    // simple request, so it is refused before anything is consumed. A client
    // that is not a browser sends neither header and keeps its access.
    if (!isSameOriginWrite(request)) {
      return HttpServerResponse.text(crossSiteFormMessage, { status: 403 });
    }

    const auth = yield* AuthService;
    const jwtService = yield* JWTService;
    const refreshTokenService = yield* RefreshTokenService;

    const presented = yield* cookieRefreshToken(request);
    const outcome = yield* Effect.result(
      auth.tokenAuthFlow(
        { accessToken: null, refreshToken: Option.getOrNull(presented) },
        request.headers["user-agent"] ?? "",
      ),
    );
    if (Result.isFailure(outcome)) {
      return outcome.failure._tag === "InternalError"
        ? HttpServerResponse.text("The session could not be refreshed just now.", { status: 500 })
        : unauthorized();
    }

    const { tokens, user } = outcome.success;
    // The refresh path always issues both tokens. A pair that is not complete
    // would leave the caller signed in to half a session, so it is refused here
    // rather than written out.
    if (tokens.accessToken == null || tokens.refreshToken == null) return unauthorized();

    const body = yield* HttpServerResponse.json({ user }).pipe(Effect.orDie);
    return yield* HttpServerResponse.setCookies(body, [
      yield* jwtService.asCookie(tokens.accessToken),
      yield* refreshTokenService.asCookie(tokens.refreshToken),
    ]).pipe(Effect.orDie);
  }),
);

/*
 * Signing out of every device, kept deliberately separate from the log-out above
 * and reachable only from its own control: it ends every session the account
 * has - the ones on other devices and the leftovers of earlier sign-ins - not
 * just the session performing it.
 *
 * The account is the one the presented cookies prove. The refresh token is
 * asked first because it is the month-long credential that identifies the
 * session, with the access token as the fallback for a browser that has lost
 * its refresh cookie while its access cookie is still live. A caller with no
 * session at all names no account; there is nothing to end and the answer is the
 * signed-out one.
 *
 * Clearing the cookies is part of the promise this route makes, and this device
 * is signed out either way. Ending the sessions on the other devices is the rest
 * of it, so a failure to revoke them is answered as a failure - with this
 * device's cookies still cleared - rather than as the signed-out page, which
 * would leave month-long refresh tokens alive while claiming they had ended.
 *
 * What this cannot reach is the access tokens already handed out: there is no
 * revocation list for them, so a session that is open right now may keep reading
 * private pages until its access token expires, within an hour. The profile
 * page says so next to the control rather than promising more than this does.
 */
const logoutEverywhere = HttpRouter.route("POST", "/api/auth/logout-all", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) {
      return HttpServerResponse.text(crossSiteFormMessage, { status: 403 });
    }

    const auth = yield* AuthService;
    const jwtService = yield* JWTService;
    const refreshTokenService = yield* RefreshTokenService;

    const presented = yield* cookieRefreshToken(request);
    const accessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(
      request.cookies["access_token"],
    ).pipe(Effect.catchTags({ SchemaError: () => Effect.succeed(null) }));

    const outcome = yield* Effect.result(
      auth
        .endAllSessions({
          refreshToken: Option.getOrNull(presented),
          accessToken,
        })
        .pipe(
          Effect.tap((revoked) =>
            Effect.logInfo(`Signing out of every device ended ${revoked} session(s)`),
          ),
          Effect.tapError((error) =>
            Effect.logError("Signing out of every device could not revoke the refresh tokens", {
              error,
            }),
          ),
        ),
    );

    const clearedCookies = [
      yield* jwtService.clearCookie(),
      yield* refreshTokenService.clearCookie(),
    ];

    if (Result.isFailure(outcome)) {
      return yield* HttpServerResponse.setCookies(
        HttpServerResponse.text(
          "Signing out of every device failed. The sessions on other devices may still be live; try again.",
          { status: 500 },
        ),
        clearedCookies,
      ).pipe(Effect.orDie);
    }

    const response = prefersHtml(request)
      ? HttpServerResponse.redirect("/login", { status: 303 })
      : HttpServerResponse.empty({ status: 204 });

    return yield* HttpServerResponse.setCookies(response, clearedCookies).pipe(Effect.orDie);
  }),
);

export const SessionRoutes = [logout, logoutEverywhere, refresh];
