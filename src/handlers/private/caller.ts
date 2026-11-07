import { JWTSchema } from "@/db/schema/brands";
import { UnauthorizedError } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import type { HttpServerRequest } from "effect/http";
import { Effect, Schema } from "effect";

/*
 * The signed-in caller's account id, read from the access-token cookie exactly
 * as `user.handler.ts` reads it. The private router's `AuthMiddleware` has
 * already established the session, so a missing or stale cookie here is an
 * unauthenticated caller: a 401, never a 500.
 */
export const callerId = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const jwtService = yield* JWTService;
    const accessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(
      request.cookies["access_token"],
    );
    const userJWT = yield* jwtService.verify(accessToken);
    const user = yield* jwtService.extractUser(userJWT);
    return user.id;
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.fail(new UnauthorizedError()),
      ExpiredJWTError: () => Effect.fail(new UnauthorizedError()),
      InvalidJWTError: () => Effect.fail(new UnauthorizedError()),
    }),
  );
