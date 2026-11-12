import { Context, Effect, Layer, Option, Schema } from "effect";
import { UserRepository } from "@/repos/user.repo";
import { ExpiredJWTError, InvalidJWTError, JWTService } from "./jwt.service";
import { HasherService } from "./hasher.service";
import { RefreshTokenRotatedError, RefreshTokenService } from "./refresh-token.service";
import { RefreshTokenNotFoundError } from "@/repos/refresh-token.repo";
import { CurrentUser, UserCredentialsType } from "@/db/schema/User";
import { InternalError, UserNotFoundError } from "./user.service";
import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";

export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentialsError",
  {},
  { httpApiStatus: 401 },
) {}

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  {},
  { httpApiStatus: 401 },
) {}

export interface AuthTokens {
  readonly accessToken: typeof JWTSchema.Type;
  readonly refreshToken: typeof RefreshTokenValue.Type;
}

export class AuthService extends Context.Service<
  AuthService,
  {
    readonly tokenAuthFlow: (
      tokens: {
        refreshToken?: typeof RefreshTokenValue.Type | null | undefined;
        accessToken?: typeof JWTSchema.Type | null | undefined;
      },
      userAgent: string,
    ) => Effect.Effect<
      {
        tokens: {
          refreshToken?: typeof RefreshTokenValue.Type | null | undefined;
          accessToken?: typeof JWTSchema.Type | null | undefined;
        };
        user: typeof CurrentUser.Type;
      },
      | InvalidJWTError
      | ExpiredJWTError
      | UserNotFoundError
      | UnauthorizedError
      | InternalError
      | RefreshTokenNotFoundError
      | RefreshTokenRotatedError
    >;
    readonly authenticate: (
      credentials: UserCredentialsType,
      userAgent: string,
    ) => Effect.Effect<AuthTokens, InternalError | InvalidCredentialsError>;
    /*
     * The other end of a session, on every device. The account is the one the
     * presented cookies prove - the refresh token first, because it is the
     * month-long credential that identifies the session, and the access token
     * when the refresh cookie is gone, because a caller holding a live access
     * token is still signed in on this device. A caller with no session names
     * no account and has nothing to end. The count is how many sessions this
     * call ended. Access tokens already issued are not recalled - there is no
     * revocation list for them - so another device's open session may keep
     * reading private pages until its access token expires, within an hour.
     */
    readonly endAllSessions: (presented: {
      readonly accessToken?: typeof JWTSchema.Type | null | undefined;
      readonly refreshToken?: typeof RefreshTokenValue.Type | null | undefined;
    }) => Effect.Effect<number, InternalError>;
    // readonly login: (credentials: UserCredentialsType, userAgent: string) => Effect.Effect<AuthTokens, InternalError | InvalidCredentialsError>
  }
>()("AuthService") {}

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const userRepo = yield* UserRepository;
    const hasher = yield* HasherService;
    const jwtService = yield* JWTService;
    const refreshTokenService = yield* RefreshTokenService;

    return {
      tokenAuthFlow: ({ accessToken: oldAccessToken, refreshToken }, userAgent) =>
        Effect.gen(function* () {
          let jwtUser = yield* Effect.fromNullishOr(oldAccessToken).pipe(
            Effect.flatMap((x) => jwtService.verify(x)),
            Effect.flatMap((x) => jwtService.extractUser(x)),
            Effect.catch(() => Effect.succeed(null)), // if it fails no user seeif refresh works
          );

          if (jwtUser) {
            return yield* Effect.succeed({
              user: jwtUser,
              tokens: {
                accessToken: oldAccessToken,
                refreshToken: refreshToken,
              },
            });
          }

          let oldRefreshToken = yield* Effect.fromNullishOr(refreshToken).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.fail(new UnauthorizedError()),
              onSuccess: (token) => Effect.succeed(token),
            }),
          );

          return yield* Effect.Do.pipe(
            Effect.bind("newAccess", () => refreshTokenService.consumeToken(oldRefreshToken)),
            Effect.bind("jwtObject", ({ newAccess }) => jwtService.verify(newAccess)),
            Effect.bind("currentUser", ({ jwtObject }) => jwtService.extractUser(jwtObject)),
            Effect.bind("newRefresh", ({ currentUser }) =>
              refreshTokenService.rotateToken(currentUser.id, userAgent, oldRefreshToken),
            ),
            Effect.map(({ newAccess, currentUser, newRefresh }) => ({
              user: currentUser,
              tokens: {
                accessToken: newAccess,
                refreshToken: newRefresh,
              },
            })),
          );
        }).pipe(Effect.tapError((err) => Effect.logError({ err }))),
      authenticate: ({ email, password }, userAgent) =>
        Effect.gen(function* () {
          const user = yield* userRepo.findByEmail(email).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new InvalidCredentialsError()),
                onSome: Effect.succeed,
              }),
            ),
          );
          yield* hasher.verifyPassword(password, user.passwordHash).pipe(
            Effect.filterOrFail(
              (bool) => bool,
              () => new InvalidCredentialsError(),
            ),
          );

          const refreshToken = yield* refreshTokenService.issueToken(user.id, userAgent);
          const jwtToken = yield* jwtService.signUser(user);
          return { accessToken: jwtToken, refreshToken };
        }).pipe(
          Effect.tapError((e) => Effect.logError(`Authentication Failed - ${e.cause}, ${e}`)),
          Effect.catchTags({
            SqlError: () => Effect.fail(new InternalError()),
            HashError: () => Effect.fail(new InternalError()),
            JWTSigningError: () => Effect.fail(new InternalError()),
          }),
        ),
      endAllSessions: ({ accessToken, refreshToken }) =>
        Effect.gen(function* () {
          const fromRefresh = Option.fromNullishOr(refreshToken).pipe(
            Option.match({
              onNone: () => Effect.succeed(Option.none<typeof UserId.Type>()),
              onSome: (token) => refreshTokenService.userIdForToken(token),
            }),
          );
          const fromAccess = Option.fromNullishOr(accessToken).pipe(
            Option.match({
              onNone: () => Effect.succeed(Option.none<typeof UserId.Type>()),
              onSome: (token) =>
                jwtService.verify(token).pipe(
                  Effect.flatMap((jwtObject) => jwtService.extractUser(jwtObject)),
                  Effect.map((user) => Option.some(user.id)),
                  // A token that cannot be verified proves no account, which is
                  // the same answer as no token at all.
                  Effect.catch(() => Effect.succeed(Option.none<typeof UserId.Type>())),
                ),
            }),
          );

          const account = yield* fromRefresh.pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => fromAccess,
                onSome: (id) => Effect.succeed(Option.some(id)),
              }),
            ),
          );

          return yield* Option.match(account, {
            onNone: () => Effect.succeed(0),
            onSome: (id) => refreshTokenService.revokeAllSessions(id),
          });
        }),
    };
  }),
);
