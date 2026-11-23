import { JWTSchema, UserId } from "@/db/schema/brands";
import { InternalError } from "@/errors";
import { handleChatSocketUpgrade } from "@/handlers/private/chat-socket";
import { ChatRepository } from "@/repos/chat.repo";
import { SqlQueryError, type RepositoryError } from "@/repos/errors";
import { UserRepository } from "@/repos/user.repo";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

const userId = Schema.decodeUnknownSync(UserId)("socket-error-user");
const accessToken = Schema.decodeUnknownSync(JWTSchema)("valid-access-token");

const unused = () => Effect.die("unused in test");

const fakeEnv = {
  CHATS: {} as unknown as DurableObjectNamespace,
  JWT_SECRET: "socket-error-test-secret",
};

const socketRequest = () =>
  new Request("http://localhost/api/chats/chat-outage-1/socket", {
    method: "GET",
    headers: {
      cookie: `access_token=${accessToken}`,
      upgrade: "websocket",
    },
  });

const makeLayer = (options: {
  readonly authFailure?: InternalError;
  readonly userFindById?: Effect.Effect<
    Option.Option<{
      readonly id: typeof UserId.Type;
      readonly email: string;
      readonly passwordHash: never;
      readonly role: "seeker";
      readonly createdAt: Date;
      readonly updatedAt: Date;
    }>,
    RepositoryError
  >;
  readonly chatFindById?: Effect.Effect<Option.Option<never>, RepositoryError>;
  readonly chatIsParticipant?: Effect.Effect<boolean, RepositoryError>;
}) =>
  Layer.mergeAll(
    Layer.succeed(AuthService, {
      tokenAuthFlow: () =>
        options.authFailure !== undefined
          ? Effect.fail(options.authFailure)
          : Effect.succeed({
              user: { id: userId, role: "seeker" as const },
              tokens: { accessToken, refreshToken: null },
            }),
      authenticate: unused,
      endAllSessions: unused,
    }),
    Layer.succeed(JWTService, {
      asCookie: unused,
      clearCookie: unused,
      signUser: unused,
      verify: () => Effect.succeed({ payload: {} } as never),
      extractUser: unused,
    }),
    Layer.succeed(RefreshTokenService, {
      asCookie: unused,
      clearCookie: unused,
      issueToken: unused,
      revokeToken: unused,
      userIdForToken: unused,
      revokeAllSessions: unused,
      consumeToken: unused,
      rotateToken: unused,
    }),
    Layer.succeed(UserRepository, {
      findByEmail: unused,
      findById: () =>
        options.userFindById ??
        Effect.succeed(
          Option.some({
            id: userId,
            email: "socket@test.local",
            passwordHash: "hash" as never,
            role: "seeker" as const,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }),
        ),
      insert: unused,
      updateRole: unused,
      deleteById: unused,
    }),
    Layer.succeed(ChatRepository, {
      openOrFind: unused,
      findById: () => options.chatFindById ?? Effect.succeed(Option.some({} as never)),
      findByListingAndSeeker: unused,
      isParticipant: () => options.chatIsParticipant ?? Effect.succeed(true),
      findDetailForUser: unused,
      listInboxForUser: unused,
      listMessagesAfter: unused,
      listRecentMessages: unused,
      markRead: unused,
    }),
  );

describe("handleChatSocketUpgrade database outage handling", () => {
  it.effect("returns 500 when tokenAuthFlow fails with InternalError", () =>
    Effect.gen(function* () {
      const response = yield* handleChatSocketUpgrade(socketRequest(), fakeEnv).pipe(
        Effect.provide(makeLayer({ authFailure: new InternalError() })),
      );
      assert.strictEqual(response.status, 500);
    }),
  );

  it.effect("returns 500 instead of 401 when UserRepository.findById fails", () =>
    Effect.gen(function* () {
      const response = yield* handleChatSocketUpgrade(socketRequest(), fakeEnv).pipe(
        Effect.provide(
          makeLayer({
            userFindById: Effect.fail(
              new SqlQueryError({ operation: "UserRepository.findById", cause: "d1 outage" }),
            ),
          }),
        ),
      );
      assert.strictEqual(response.status, 500);
    }),
  );

  it.effect("returns 500 instead of 404 when ChatRepository.findById fails", () =>
    Effect.gen(function* () {
      const response = yield* handleChatSocketUpgrade(socketRequest(), fakeEnv).pipe(
        Effect.provide(
          makeLayer({
            chatFindById: Effect.fail(
              new SqlQueryError({ operation: "ChatRepository.findById", cause: "d1 outage" }),
            ),
          }),
        ),
      );
      assert.strictEqual(response.status, 500);
    }),
  );

  it.effect("returns 500 instead of 403 when ChatRepository.isParticipant fails", () =>
    Effect.gen(function* () {
      const response = yield* handleChatSocketUpgrade(socketRequest(), fakeEnv).pipe(
        Effect.provide(
          makeLayer({
            chatIsParticipant: Effect.fail(
              new SqlQueryError({ operation: "ChatRepository.isParticipant", cause: "d1 outage" }),
            ),
          }),
        ),
      );
      assert.strictEqual(response.status, 500);
    }),
  );
});
