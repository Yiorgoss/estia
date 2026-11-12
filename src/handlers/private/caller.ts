import { UserId } from "@/db/schema/brands";
import { UserRepository } from "@/repos/user.repo";
import { UnauthorizedError } from "@/services/auth.service";
import { InternalError } from "@/services/user.service";
import { Context, Effect, Option } from "effect";

/*
 * The account `AuthMiddleware` established for this request. The middleware
 * resolves the session once, before the route runs, so a handler never verifies
 * a cookie of its own: the access token it acts on is the one the resolver
 * accepted, whether the browser presented it live or swapped a live refresh
 * token for it.
 */
export class CurrentUserId extends Context.Service<CurrentUserId, typeof UserId.Type>()(
  "CurrentUserId",
) {}

// The route's caller, provided by `AuthMiddleware`, so a missing session is
// refused at the boundary rather than inside a handler.
export const callerId = CurrentUserId;

/*
 * The caller's stored account. The token only proves who is asking; the row is
 * what that account is right now. The `role` claim inside the token is
 * informational, so reading it here would keep a role the account no longer has
 * alive until the token is reissued - up to an hour. A token whose owner is gone
 * is an unauthenticated caller, not a server error.
 */
export const callerUser = Effect.gen(function* () {
  const id = yield* callerId;
  const userRepo = yield* UserRepository;
  const user = yield* userRepo.findById(id).pipe(Effect.mapError(() => new InternalError()));
  if (Option.isNone(user)) {
    return yield* Effect.fail(new UnauthorizedError());
  }
  return user.value;
});
