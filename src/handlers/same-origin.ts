import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const stateChangingMethods: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isStateChangingRequest = (request: HttpServerRequest.HttpServerRequest): boolean =>
  stateChangingMethods.has(request.method);

/*
 * A state-changing request is a simple request, so CORS never sees it: another
 * site's page can post one to this app without a preflight, and the browser
 * attaches whatever cookies its policy allows. The session cookies are
 * `SameSite=Lax`, so a cross-site post carries no session today - but that is one
 * cookie attribute away from disappearing, so the page forms and the private API
 * check where the request came from instead.
 *
 * The page's own origin is the one the browser reached, so the request URL is the
 * authority, not a configured host name. A same-site but different origin
 * (a sibling subdomain) still carries the cookie, so it is refused too. Browsers
 * label their own posts and `Sec-Fetch-Site` is their own statement, so it is
 * decisive when present. A client sending none of these headers is not a browser,
 * so it keeps the access it has always had.
 */
export const isSameOriginWrite = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined) return fetchSite === "same-origin" || fetchSite === "none";

  const source = request.headers["origin"] ?? request.headers["referer"];
  if (source === undefined) return true;

  const requestOrigin = originOf(request.originalUrl);
  return requestOrigin !== undefined && originOf(source) === requestOrigin;
};

// One sentence for every refused surface, so the answer reads the same wherever
// the person meets it.
export const crossSiteFormMessage =
  "This form can only be submitted from this site's own page. Open the page and try again.";

/*
 * The JSON API's side of the same rule. Every state-changing request registered
 * under the private API passes through this boundary before its handler runs, so
 * no handler has to restate it - including the routes that take no payload and
 * are therefore reachable from another site's page as a plain form post. An
 * endpoint that requires a JSON body is already unreachable cross-site without a
 * preflight; this covers it anyway at no extra cost.
 *
 * A browser client on another origin is refused like any other, so a future
 * cross-origin client would need an explicit origin allowlist added here.
 * Nothing that exists today is one: the pages are served from this app, and tools
 * and scripts send neither of the headers.
 */
export const SameOriginWriteMiddleware = HttpRouter.middleware((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (isStateChangingRequest(request) && !isSameOriginWrite(request)) {
      return HttpServerResponse.text(crossSiteFormMessage, { status: 403 });
    }
    return yield* app;
  }),
).layer;
