import { CurrentUserId } from "@/handlers/private/caller";
import { sessionResolver, retrySessionResponse } from "@/handlers/optional-caller";
import { signInRequiredPage } from "@/frontend/pages/sign-in-required";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Effect } from "effect";

const isHtmx = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers["hx-request"] === "true";

/*
 * A request under `/api` is the JSON API, whose contract for a missing session
 * is a 401. Every other private route is a page, and a page answers a signed-out
 * visitor with a prompt carrying a sign-in link, never a bare error string. An
 * htmx request is answered with a real navigation instead, because htmx swaps
 * only 2xx responses and would otherwise discard the sign-in page and leave the
 * page looking as if nothing happened.
 */
const unauthenticatedResponse = (request: HttpServerRequest.HttpServerRequest) =>
  isHtmx(request)
    ? HttpServerResponse.empty({ status: 200, headers: { "HX-Redirect": "/login" } })
    : new URL(request.originalUrl).pathname.startsWith("/api/")
      ? HttpServerResponse.text("UnauthorizedError", { status: 401 })
      : HttpServerResponse.text(signInRequiredPage, { status: 401, contentType: "text/html" });

/*
 * The one place a private request establishes its session. It runs before the
 * route, so the caller every handler reads is the account the resolver proved,
 * and it registers the session's cookie pair on the response this request ends
 * with - a page, a fragment, a refusal, or the error the runtime derives from a
 * route that failed. The pair is registered rather than attached to the route's
 * own response, because a route that fails produces no response, and the
 * resolver has already spent the presented refresh token by then.
 */
export const AuthMiddleware = HttpRouter.middleware<{ provides: CurrentUserId }>()(
  Effect.gen(function* () {
    const resolve = yield* sessionResolver;
    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* resolve({
          cookies: request.cookies,
          userAgent: request.headers["user-agent"],
        });
        if (session._tag === "retry") return retrySessionResponse(request);
        if (session._tag === "anonymous") return unauthenticatedResponse(request);
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setCookiesUnsafe(response, session.cookies)),
        );
        return yield* Effect.provideService(app, CurrentUserId, session.caller);
      });
  }),
).layer;
