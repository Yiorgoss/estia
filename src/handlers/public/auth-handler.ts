import { PublicApi } from "@/api/public";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { InternalError, UserService } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import { Effect } from "effect";

export const PublicApiLive = HttpApiBuilder.group(PublicApi, "auth", (handlers) =>
  handlers
    .handle("login", (req) =>
      Effect.gen(function* () {
        //validate user
        yield* Effect.logDebug("attempting login");
        const { email, password } = req.payload;
        const userAgent = req.request.headers["user-agent"];

        const authService = yield* AuthService;
        const { accessToken, refreshToken } = yield* authService.authenticate(
          { email, password },
          userAgent,
        );
        yield* Effect.logInfo("authentication successful");
        const jwtService = yield* JWTService;
        const accessCookie = yield* jwtService.asCookie(accessToken);
        const refreshTokenService = yield* RefreshTokenService;
        const refreshCookie = yield* refreshTokenService.asCookie(refreshToken);

        return yield* HttpServerResponse.empty().pipe(
          HttpServerResponse.setStatus(200),
          HttpServerResponse.setCookies([accessCookie, refreshCookie]),
          Effect.orDie,
        );
      }),
    )
    .handle("register", (req) =>
      Effect.gen(function* () {
        const { email, password } = req.payload;
        const userAgent = req.request.headers["user-agent"];

        const userService = yield* UserService;
        yield* userService.registerUser({ email, password }, userAgent);
        const authService = yield* AuthService;
        const { accessToken, refreshToken } = yield* authService.authenticate(
          { email, password },
          userAgent,
        );

        yield* Effect.logInfo("Successfully Registered");

        // The cookie's attributes live in the services that issue the tokens, so
        // the API's session is the same session the pages issue - SameSite
        // included. A second copy of the options here would drift from them.
        const jwtService = yield* JWTService;
        const accessCookie = yield* jwtService.asCookie(accessToken);
        const refreshTokenService = yield* RefreshTokenService;
        const refreshCookie = yield* refreshTokenService.asCookie(refreshToken);

        return yield* HttpServerResponse.empty().pipe(
          HttpServerResponse.setStatus(200),
          HttpServerResponse.setCookies([accessCookie, refreshCookie]),
          Effect.orDie,
        );
      }).pipe(
        // A duplicate registration keeps its own 409 so the caller can act on it;
        // anything else is reported as the server failure it is.
        Effect.catchTags({
          UserAlreadyExistsError: (error) => Effect.fail(error),
          InvalidCredentialsError: () => Effect.fail(new InternalError()),
        }),
      ),
    ),
);
