import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { HashError, HasherService } from "./hasher.service";
import { RefreshTokenNotFoundError, RefreshTokenRepository } from "@/repos/refresh-token.repo";
import type { SqlError } from "effect/sql/SqlError";

import { JWTService } from "./jwt.service";
import { UserRepository } from "@/repos/user.repo";
import { InternalError, UserNotFoundError } from "./user.service";

import { Cookies } from "effect/http";
import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { clearedCookie } from "./session-cookies";

// export class InvalidRefreshTokenError extends Schema.TaggedError<InvalidRefreshTokenError>()(
//   "InvalidRefreshTokenError",
//   {},) { }

/*
 * The refresh cookie's attributes, in one place. Issuing a token and clearing it
 * must agree on the path and the flags, or the browser keeps the old cookie
 * beside the new one, so both go through this record.
 */
const refreshCookieOptions = {
  httpOnly: true,
  secure: true,
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000, // one month
  // `Lax` keeps the session on top-level navigations and off a
  // cross-site form post. The origin check in `@/handlers/same-origin`
  // is the other half of that defence.
  sameSite: "lax",
} as const satisfies NonNullable<Cookies.Cookie["options"]>;

export interface RefreshTokenService {
  asCookie: (
    token: typeof RefreshTokenValue.Type,
  ) => Effect.Effect<[name: string, value: string, options?: Cookies.Cookie["options"]], never>;
  clearCookie: () => Effect.Effect<
    [name: string, value: string, options?: Cookies.Cookie["options"]],
    never
  >;
  issueToken: (
    id: typeof UserId.Type,
    userAgent: string,
  ) => Effect.Effect<typeof RefreshTokenValue.Type, HashError | SqlError>;
  /*
   * Ends one session: the row the presented token hashes to is marked revoked,
   * so the token cannot be replayed. A token that is already revoked, expired,
   * or unknown has nothing to revoke left and is not a failure - signing out
   * has the same answer either way.
   */
  revokeToken: (token: typeof RefreshTokenValue.Type) => Effect.Effect<void, InternalError>;
  consumeToken: (
    token: typeof RefreshTokenValue.Type,
  ) => Effect.Effect<
    typeof JWTSchema.Type,
    InternalError | UserNotFoundError | RefreshTokenNotFoundError
  >;
  rotateToken: (
    userId: typeof UserId.Type,
    userAgent: string,
    token: typeof RefreshTokenValue.Type,
  ) => Effect.Effect<typeof RefreshTokenValue.Type, InternalError | RefreshTokenNotFoundError>;
}
export const RefreshTokenService = Context.Service<RefreshTokenService>("RefreshTokenService");

export const RefreshTokenServiceLive = Layer.effect(
  RefreshTokenService,
  Effect.gen(function* () {
    // const domain = yield* Config.string("DOMAIN")
    const hasher = yield* HasherService;
    const refreshTokenRepo = yield* RefreshTokenRepository;
    // const refreshTokenService = yield* RefreshTokenService
    const userRepo = yield* UserRepository;
    const jwtService = yield* JWTService;

    return {
      asCookie: (token) => Effect.succeed(["refresh_token", token, refreshCookieOptions]),
      clearCookie: () => clearedCookie("refresh_token", refreshCookieOptions),
      revokeToken: (token) =>
        Effect.gen(function* () {
          const hash = yield* hasher.hashRefreshToken(token);
          const revoked = yield* refreshTokenRepo.revoke(hash);
          if (Option.isNone(revoked)) {
            yield* Effect.logInfo("Signing out found no live refresh token to revoke");
          }
        }).pipe(
          Effect.catchTags({
            HashError: () => Effect.fail(new InternalError()),
            SqlError: () => Effect.fail(new InternalError()),
          }),
        ),
      issueToken: (id, userAgent) =>
        Effect.gen(function* () {
          const token = Schema.decodeSync(RefreshTokenValue)(
            crypto.getRandomValues(new Uint8Array(32)).toHex(),
          );

          const hash = yield* hasher.hashRefreshToken(token);
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

          yield* refreshTokenRepo.new({
            userId: id,
            tokenHash: hash,
            expiresAt,
            deviceInfo: userAgent,
          });

          return token;
        }),
      rotateToken: (userId, userAgent, token) =>
        Effect.gen(function* () {
          const oldToken = yield* hasher.hashRefreshToken(token);
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

          const revoked = yield* refreshTokenRepo.revoke(oldToken);
          yield* revoked.pipe(
            Option.match({
              onNone: () => Effect.fail(new RefreshTokenNotFoundError()),
              onSome: Effect.succeed,
            }),
          );

          const newTokenValue = Schema.decodeSync(RefreshTokenValue)(
            crypto.getRandomValues(new Uint8Array(32)).toHex(),
          );

          const newTokenHash = yield* hasher.hashRefreshToken(newTokenValue);

          // const tokenHash = yield*
          yield* refreshTokenRepo.new({
            userId,
            expiresAt,
            deviceInfo: userAgent,
            tokenHash: newTokenHash,
          });
          return newTokenValue;
        }).pipe(
          Effect.catchTags({
            HashError: () => Effect.fail(new InternalError()),
            SqlError: () => Effect.fail(new InternalError()),
          }),
        ),
      consumeToken: (token) =>
        Effect.gen(function* () {
          //does token exist and is valid
          const tokenHash = yield* hasher.hashRefreshToken(token);
          const validToken = yield* refreshTokenRepo.findValidByHash(tokenHash);
          const tokenRecord = yield* validToken.pipe(
            Option.match({
              onNone: () => Effect.fail(new RefreshTokenNotFoundError()),
              onSome: Effect.succeed,
            }),
          );

          // get associated user
          const user = yield* userRepo.findById(tokenRecord.userId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new UserNotFoundError({ cause: "User Not Found" })),
                onSome: Effect.succeed,
              }),
            ),
          );

          //construct jwt
          const newJWT = yield* jwtService.signUser(user);
          return newJWT;
          // const newRefreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
          // return { accessToken: newJWT, refreshToken: newRefreshToken }
        }).pipe(
          Effect.catchTags({
            HashError: () => Effect.fail(new InternalError()),
            SqlError: () => Effect.fail(new InternalError()),
            JWTSigningError: () => Effect.fail(new InternalError()),
          }),
        ),
    };
  }),
);
