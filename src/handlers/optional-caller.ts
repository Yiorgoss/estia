import { JWTSchema, UserId } from "@/db/schema/brands";
import { JWTService } from "@/services/jwt.service";
import type { HttpServerRequest } from "effect/http";
import { Effect, Option, Result, Schema } from "effect";

/*
 * The id a presented access cookie proves, for a public page that renders a
 * little extra for a signed-in visitor. Unlike `AuthMiddleware` this never
 * fails and never rotates a token: a stale, malformed, or missing cookie simply
 * means the page is rendered for a visitor, which is the safe direction for a
 * search page. A private request is still gated by the middleware and its 401.
 */
export const optionalCallerId = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Option.Option<typeof UserId.Type>, never, JWTService> =>
  Effect.gen(function* () {
    const raw = request.cookies["access_token"];
    if (raw === undefined) return Option.none();

    const decoded = yield* Effect.result(Schema.decodeUnknownEffect(JWTSchema)(raw));
    if (Result.isFailure(decoded)) return Option.none();

    const jwtService = yield* JWTService;
    const verified = yield* Effect.result(jwtService.verify(decoded.success));
    if (Result.isFailure(verified)) return Option.none();

    const user = yield* Effect.result(jwtService.extractUser(verified.success));
    return Result.isFailure(user) ? Option.none() : Option.some(user.success.id);
  });
