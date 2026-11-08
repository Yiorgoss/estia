import { authFormEmail, decodeLoginForm, decodeRegisterForm } from "@/frontend/auth-form";
import { loginPage, registerPage } from "@/frontend/pages/auth";
import { AuthService, type AuthTokens } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { UserService } from "@/services/user.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";
import { Effect, Result } from "effect";

/*
 * Browser-facing sign-in and registration. These are page routes, not part of the
 * JSON API: the form posts `application/x-www-form-urlencoded`, the route runs the
 * same `AuthService`/`UserService` the API handlers run, and every submit is
 * answered with a page - a redirect to the feed on success, the same page with a
 * readable reason on failure. The JSON endpoints keep decoding JSON only.
 */

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

// A JSON body here would be parsed as one odd form key and reported as a missing
// field, which is a misleading answer for a client that picked the wrong surface,
// so a body that is not a form post is rejected as such.
const unsupportedBodyMessage = "This page expects a form submission, not a raw request body.";

const isFormPost = (request: HttpServerRequest.HttpServerRequest): boolean =>
  (request.headers["content-type"] ?? "").toLowerCase().startsWith(FORM_CONTENT_TYPE);

const crossSiteMessage =
  "This form can only be submitted from this site's own page. Open the page and try again.";

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

// A form post is a simple request, so CORS never sees it, and the cookies a
// cross-site submit would receive would sign the visitor in as the submitter.
// The page's own origin is the one the browser reached, so the request URL is the
// authority, not a configured host name. Browsers label their own posts; a client
// sending none of these headers is not a browser, so it keeps the access the JSON
// API already gives it.
const isSameOriginFormPost = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined) return fetchSite === "same-origin" || fetchSite === "none";

  const source = request.headers["origin"] ?? request.headers["referer"];
  if (source === undefined) return true;

  const requestOrigin = originOf(request.originalUrl);
  return requestOrigin !== undefined && originOf(source) === requestOrigin;
};

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(request.urlParamsBody, UrlParams.toRecord).pipe(Effect.orDie);

const userAgentOf = (request: HttpServerRequest.HttpServerRequest): string =>
  request.headers["user-agent"] ?? "";

const respond = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

// A signed-in visitor is sent to the feed, which is where a person wants to be
// once they are in. The cookies carry the session the JSON API would have issued.
const signedInResponse = (tokens: AuthTokens) =>
  Effect.gen(function* () {
    const jwtService = yield* JWTService;
    const refreshTokenService = yield* RefreshTokenService;
    const accessCookie = yield* jwtService.asCookie(tokens.accessToken);
    const refreshCookie = yield* refreshTokenService.asCookie(tokens.refreshToken);

    return yield* HttpServerResponse.redirect("/search", { status: 303 }).pipe(
      HttpServerResponse.setCookies([accessCookie, refreshCookie]),
      Effect.orDie,
    );
  });

const login = HttpRouter.route("POST", "/login", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginFormPost(request)) {
      return respond(loginPage({ message: crossSiteMessage }), 403);
    }

    if (!isFormPost(request)) {
      return respond(loginPage({ message: unsupportedBodyMessage }), 415);
    }

    const params = yield* readForm(request);
    const decoded = decodeLoginForm(params);
    if (!decoded.ok) {
      return respond(loginPage({ email: authFormEmail(params), message: decoded.message }), 400);
    }

    const authService = yield* AuthService;
    return yield* authService.authenticate(decoded.input, userAgentOf(request)).pipe(
      Effect.flatMap(signedInResponse),
      Effect.catchTags({
        InvalidCredentialsError: () =>
          Effect.succeed(
            respond(
              loginPage({
                email: decoded.input.email,
                message: "That email and password do not match. Check them and try again.",
              }),
              401,
            ),
          ),
        InternalError: () =>
          Effect.succeed(
            respond(
              loginPage({
                email: decoded.input.email,
                message: "Signing in is not possible just now. Please try again in a moment.",
              }),
              500,
            ),
          ),
      }),
    );
  }),
);

const register = HttpRouter.route("POST", "/register", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginFormPost(request)) {
      return respond(registerPage({ message: crossSiteMessage }), 403);
    }

    if (!isFormPost(request)) {
      return respond(registerPage({ message: unsupportedBodyMessage }), 415);
    }

    const params = yield* readForm(request);
    const decoded = decodeRegisterForm(params);
    if (!decoded.ok) {
      return respond(registerPage({ email: authFormEmail(params), message: decoded.message }), 400);
    }

    const userService = yield* UserService;
    const authService = yield* AuthService;
    const userAgent = userAgentOf(request);

    const registration = yield* Effect.result(userService.registerUser(decoded.input, userAgent));

    if (Result.isFailure(registration)) {
      // Only a duplicate leaves an account behind; every other failure is a
      // refused registration, so the account does not exist.
      return registration.failure._tag === "UserAlreadyExistsError"
        ? respond(
            registerPage({
              email: decoded.input.email,
              message:
                "An account already exists for that email address. Sign in instead, or register with a different address.",
            }),
            409,
          )
        : respond(
            registerPage({
              email: decoded.input.email,
              message:
                "Creating an account is not possible just now. Please try again in a moment.",
            }),
            500,
          );
    }

    // The account exists from here on, so auto-signing in must never be reported
    // as a failed registration. Registering signs the person in, so they land on
    // the feed instead of being asked for the password they just chose.
    const accountCreated = () =>
      respond(
        registerPage({
          email: decoded.input.email,
          message: "The account was created, but signing in did not work. Try signing in.",
        }),
        500,
      );

    return yield* authService.authenticate(decoded.input, userAgent).pipe(
      Effect.flatMap(signedInResponse),
      Effect.catchTags({
        InvalidCredentialsError: () => Effect.succeed(accountCreated()),
        InternalError: () => Effect.succeed(accountCreated()),
      }),
    );
  }),
);

export const AuthPageRoutes = [login, register];
