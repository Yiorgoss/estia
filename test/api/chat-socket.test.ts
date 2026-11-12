import { ListingId, UserId } from "@/db/schema/brands";
import { CHAT_TICKET_HEADER, verifyChatTicket } from "@/durable-objects/chat-ticket";
import { handleChatSocketUpgrade } from "@/handlers/chat-socket";
import { RefreshTokenRepositoryLive } from "@/repos/refresh-token.repo";
import { ChatRepository, ChatRepositoryLive } from "@/repos/chat.repo";
import { UserRepositoryLive } from "@/repos/user.repo";
import { AuthServiceLive } from "@/services/auth.service";
import { ChatTicketServiceLive } from "@/services/chat-ticket.service";
import { HasherServiceLive } from "@/services/hasher.service";
import { JWTServiceLive } from "@/services/jwt.service";
import { RefreshTokenServiceLive } from "@/services/refresh-token.service";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SignJWT } from "jose";
import { afterAll } from "vitest";
import { TEST_JWT_SECRET } from "../support/chat-object";
import { insertListing, insertUser } from "../support/seed";
import { TestSqlLive } from "../support/sql";

/*
 * The Worker's side of a socket upgrade: who is refused before a socket exists,
 * and what the object is told when one is allowed. The object itself is a fake
 * here - it records the request it was handed - because the point of these tests
 * is the boundary: the session, the D1 membership check, the signed ticket, and
 * the identity headers that must not reach the object.
 */

const DOMAIN = "http://listings.test";
const JWT_SECRET = TEST_JWT_SECRET;

const ConfigLive = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ DOMAIN, JWT_SECRET, ENVIRONMENT: "local" }),
);

/*
 * The same wiring the app does, spelled out: repositories over the test database,
 * the token signers over the configuration, and the two session services over
 * both. A merged layer does not satisfy its own siblings, so each stage provides
 * what the next one needs.
 */
const RepositoriesLive = Layer.mergeAll(
  UserRepositoryLive,
  RefreshTokenRepositoryLive,
  ChatRepositoryLive,
).pipe(Layer.provideMerge(TestSqlLive));

const InfraLive = Layer.mergeAll(HasherServiceLive, JWTServiceLive, ChatTicketServiceLive).pipe(
  Layer.provide(ConfigLive),
);

const RefreshTokenServiceFully = RefreshTokenServiceLive.pipe(
  Layer.provide(Layer.mergeAll(RepositoriesLive, InfraLive)),
);

const SocketServicesLive = Layer.mergeAll(
  AuthServiceLive.pipe(
    Layer.provide(Layer.mergeAll(RepositoriesLive, InfraLive, RefreshTokenServiceFully)),
  ),
  RefreshTokenServiceFully,
  InfraLive,
  RepositoriesLive,
);

const runtime = ManagedRuntime.make(SocketServicesLive);

afterAll(async () => {
  await runtime.dispose();
});

const OWNER = "u-socket-owner";
const SEEKER = "u-socket-seeker";
const STRANGER = "u-socket-stranger";

const chatId = await runtime.runPromise(
  Effect.gen(function* () {
    yield* insertUser(OWNER, "socket-owner@test.local", "lister");
    yield* insertUser(SEEKER, "socket-seeker@test.local", "seeker");
    yield* insertUser(STRANGER, "socket-stranger@test.local", "seeker");
    yield* insertListing(101, OWNER, { status: "published" });
    const repo = yield* ChatRepository;
    const chat = yield* repo.findOrCreate({
      listingId: Schema.decodeSync(ListingId)(101),
      seekerUserId: Schema.decodeSync(UserId)(SEEKER),
      listerUserId: Schema.decodeSync(UserId)(OWNER),
    });
    return chat.id;
  }),
);

const accessToken = async (userId: string, expiresAt?: number) => {
  const token = new SignJWT({ id: userId, role: "seeker" })
    .setSubject(userId)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(`${DOMAIN}/login`)
    .setAudience(DOMAIN);
  return (
    expiresAt === undefined ? token.setExpirationTime("1h") : token.setExpirationTime(expiresAt)
  ).sign(new TextEncoder().encode(JWT_SECRET));
};

interface Forwarded {
  readonly chatId: string;
  readonly request: Request;
}

const fakeChats = () => {
  const forwarded: Array<Forwarded> = [];
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { readonly name: string }) => ({
      fetch: async (request: Request) => {
        forwarded.push({ chatId: id.name, request });
        // The handler passes a non-101 answer straight back, which is what a
        // refusal from the object looks like and is all this fake needs to prove
        // the request reached it.
        return new Response("upstream", { status: 200 });
      },
    }),
  };
  return {
    namespace: namespace as unknown as DurableObjectNamespace,
    forwarded,
  };
};

const upgradeRequest = (options: {
  readonly chatId: string;
  readonly cookie?: string;
  readonly after?: number;
  readonly headers?: Readonly<Record<string, string>>;
}) =>
  new Request(`${DOMAIN}/api/chats/${options.chatId}/socket?after=${options.after ?? 0}`, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
  });

const upgrade = (
  options: {
    readonly chatId?: string;
    readonly cookie?: string;
    readonly after?: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly request?: Request;
  } = {},
) => {
  const chats = fakeChats();
  const request =
    options.request ??
    upgradeRequest({
      chatId: options.chatId ?? String(chatId),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
  return Effect.promise(async () => {
    const response = await handleChatSocketUpgrade({
      request,
      chats: chats.namespace,
      run: (effect) => runtime.runPromise(effect),
    });
    return { response, forwarded: chats.forwarded };
  });
};

describe("handleChatSocketUpgrade", () => {
  it.effect("answers a non-upgrade request and a non-numeric chat id without a session", () =>
    Effect.gen(function* () {
      const plain = yield* upgrade({
        request: new Request(`${DOMAIN}/api/chats/${chatId}/socket`),
      });
      assert.strictEqual(plain.response.status, 426);
      assert.strictEqual(plain.forwarded.length, 0);

      const notANumber = yield* upgrade({ chatId: "abc" });
      assert.strictEqual(notANumber.response.status, 404);
      assert.strictEqual(notANumber.forwarded.length, 0);
    }),
  );

  it.effect("refuses a missing, malformed, or expired session before a socket exists", () =>
    Effect.gen(function* () {
      const anonymous = yield* upgrade();
      assert.strictEqual(anonymous.response.status, 401);
      assert.strictEqual(anonymous.forwarded.length, 0);

      const garbage = yield* upgrade({ cookie: "access_token=not-a-jwt" });
      assert.strictEqual(garbage.response.status, 401);
      assert.strictEqual(garbage.forwarded.length, 0);

      const expiredToken = yield* Effect.promise(() =>
        accessToken(SEEKER, Math.floor(Date.now() / 1000) - 60),
      );
      const expired = yield* upgrade({ cookie: `access_token=${expiredToken}` });
      assert.strictEqual(expired.response.status, 401);
      assert.strictEqual(expired.forwarded.length, 0);
    }),
  );

  it.effect("refuses a handshake another site's page opened", () =>
    Effect.gen(function* () {
      const token = yield* Effect.promise(() => accessToken(SEEKER));
      const refused = yield* upgrade({
        cookie: `access_token=${token}`,
        headers: { origin: "https://evil.example" },
      });

      assert.strictEqual(refused.response.status, 403);
      assert.strictEqual(refused.forwarded.length, 0);
    }),
  );

  it.effect("refuses a signed-in account that is not a participant", () =>
    Effect.gen(function* () {
      const token = yield* Effect.promise(() => accessToken(STRANGER));
      const refused = yield* upgrade({ cookie: `access_token=${token}` });

      assert.strictEqual(refused.response.status, 403);
      assert.strictEqual(refused.forwarded.length, 0);
    }),
  );

  it.effect(
    "forwards a participant's upgrade with a signed ticket and none of the client's identity",
    () =>
      Effect.gen(function* () {
        const token = yield* Effect.promise(() => accessToken(SEEKER));
        const allowed = yield* upgrade({
          cookie: `access_token=${token}`,
          after: 3,
          // A client that tries to name itself, and to bring its own ticket, is
          // ignored: neither survives into the forwarded request.
          headers: {
            "x-user-id": OWNER,
            "x-user-role": "lister",
            [CHAT_TICKET_HEADER]: "forged-ticket-from-the-browser",
          },
        });

        // The fake object's answer is returned as-is.
        assert.strictEqual(allowed.response.status, 200);
        assert.strictEqual(allowed.forwarded.length, 1, "the object was reached once");

        const forwarded = allowed.forwarded[0];
        assert.strictEqual(forwarded?.chatId, String(chatId));
        assert.strictEqual(forwarded?.request.headers.get("upgrade"), "websocket");
        assert.strictEqual(new URL(forwarded?.request.url ?? "").searchParams.get("after"), "3");

        // Nothing the browser said about itself is forwarded.
        assert.isNull(forwarded?.request.headers.get("cookie") ?? null);
        assert.isNull(forwarded?.request.headers.get("x-user-id") ?? null);
        assert.isNull(forwarded?.request.headers.get("x-user-role") ?? null);

        const ticket = yield* Effect.promise(() =>
          verifyChatTicket(
            JWT_SECRET,
            forwarded?.request.headers.get(CHAT_TICKET_HEADER) ?? "",
            Date.now(),
          ),
        );
        assert.isDefined(ticket, "the forwarded ticket verifies with the app's secret");
        assert.strictEqual(ticket?.userId, SEEKER);
        assert.strictEqual(ticket?.chatId, chatId);
      }),
  );
});
