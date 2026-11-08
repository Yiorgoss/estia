import { HttpServerRequest } from "effect/http";

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/*
 * A form post is a simple request, so CORS never sees it: another site's page can
 * post one to this app without a preflight, and the browser attaches whatever
 * cookies its policy allows. The session cookies are `SameSite=Lax`, so a
 * cross-site post carries no session today - but that is one cookie attribute
 * away from disappearing, so every state-changing form route also checks where
 * the request came from.
 *
 * The page's own origin is the one the browser reached, so the request URL is the
 * authority, not a configured host name. Browsers label their own posts and
 * `Sec-Fetch-Site` is their own statement, so it is decisive when present. A
 * client sending none of these headers is not a browser and keeps the access the
 * JSON API already gives it.
 */
export const isSameOriginFormPost = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined) return fetchSite === "same-origin" || fetchSite === "none";

  const source = request.headers["origin"] ?? request.headers["referer"];
  if (source === undefined) return true;

  const requestOrigin = originOf(request.originalUrl);
  return requestOrigin !== undefined && originOf(source) === requestOrigin;
};

// One sentence for every form surface, so a refused submit reads the same
// wherever the person meets it.
export const crossSiteFormMessage =
  "This form can only be submitted from this site's own page. Open the page and try again.";
