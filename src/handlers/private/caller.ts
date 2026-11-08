import { JWTSchema } from "@/db/schema/brands";
import { UserRepository } from "@/repos/user.repo";
import { UnauthorizedError } from "@/services/auth.service";
import { InternalError } from "@/services/user.service";
import { JWTService } from "@/services/jwt.service";
import type { HttpServerRequest } from "effect/http";
import { Effect, Option, Schema } from "effect";

/*
 * The account id the access token proves. The private router's `AuthMiddleware`
 * has already established the session, so a missing or stale cookie here is an
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

/*
 * The caller's stored account. The token only proves who is asking; the row is
 * what that account is right now. The `role` claim inside the token is
 * informational, so reading it here would keep a role the account no longer has
 * alive until the token is reissued - up to an hour. A token whose owner is gone
 * is an unauthenticated caller, not a server error.
 */
export const callerUser = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const id = yield* callerId(request);
    const userRepo = yield* UserRepository;
    const user = yield* userRepo.findById(id).pipe(Effect.mapError(() => new InternalError()));
    if (Option.isNone(user)) {
      return yield* Effect.fail(new UnauthorizedError());
    }
    return user.value;
  });
