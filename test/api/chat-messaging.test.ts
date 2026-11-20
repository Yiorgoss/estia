import {
  CHAT_CLOSE_AUTH_EXPIRED,
  CHAT_TICKET_HEADER,
  signChatTicket,
} from "@/services/chat-ticket";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  asObject,
  call,
  callChatSocket,
  form,
  query,
  register,
  send,
  testChatNamespace,
  testJwtSecret,
  testOrigin,
  type TestUser,
} from "../support/api";
import type { MockWebSocket } from "../support/chat-do";

/*
 * End-to-end integration tests for one-to-one chats driven through the real
 * Worker HTTP handlers, real `handleChatSocketUpgrade` boundary, real `Chat`
 * Durable Object class, and in-memory D1-shaped SQLite database.
 */

const createPublishedListing = (owner: TestUser, title = "Sunny Athens flat") =>
  Effect.gen(function* () {
    const created = yield* send("POST", "/api/listings", {
      cookie: owner.cookie,
      payload: {
        kind: "room",
        title,
        description: "Close to the metro",
        priceMinor: 85_000,
        regionCode: "attica",
        sizeSqm: 35,
      },
    });
    assert.strictEqual(created.status, 200, created.body);
    const id = asObject(created.json).id as number;
    const published = yield* send("POST", `/api/listings/${id}/publish`, {
      cookie: owner.cookie,
    });
    assert.strictEqual(published.status, 200, published.body);
    return id;
  });

const openSocket = (
  chatId: string,
  cookie: string,
  extraPath = "",
  extraHeaders: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const response = yield* callChatSocket(`/api/chats/${chatId}/socket${extraPath}`, {
      method: "GET",
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        cookie,
        "user-agent": "estia-tests",
        ...extraHeaders,
      },
    });
    return response;
  });

const socketFrom101 = (response: Response): MockWebSocket => {
  assert.strictEqual(response.status, 101);
  const ws = (response as unknown as { webSocket?: MockWebSocket }).webSocket;
  assert.isDefined(ws);
  return ws as MockWebSocket;
};

describe("Chats: creation, ordering, gap replay, auth, hibernation, unread, and POST parity", () => {
  it.effect("creates a chat from the listing detail CTA and refuses self-chat or draft listings", () =>
    Effect.gen(function* () {
      const lister = yield* register("chat-cta-lister");
      const seeker = yield* register("chat-cta-seeker");

      // Draft listing cannot open a chat.
      const draftRes = yield* send("POST", "/api/listings", {
        cookie: lister.cookie,
        payload: {
          kind: "room",
          title: "Unpublished room",
          priceMinor: 60_000,
          regionCode: "crete",
        },
      });
      const draftId = asObject(draftRes.json).id as number;
      const draftOpen = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId: draftId },
      });
      assert.strictEqual(draftOpen.status, 404);

      const listingId = yield* createPublishedListing(lister, "Kolonaki Balcony Room");

      // Signed-out visitor sees sign-in CTA; owner sees view-chats CTA; seeker sees Message lister form.
      const anonPage = yield* call(`/listings/${listingId}`);
      assert.strictEqual(anonPage.status, 200);
      assert.include(anonPage.body, "Sign in to message");

      const ownerPage = yield* call(`/listings/${listingId}`, {
        headers: { cookie: lister.cookie },
      });
      assert.strictEqual(ownerPage.status, 200);
      assert.include(ownerPage.body, "View chats");

      const seekerPageBefore = yield* call(`/listings/${listingId}`, {
        headers: { cookie: seeker.cookie },
      });
      assert.strictEqual(seekerPageBefore.status, 200);
      assert.include(seekerPageBefore.body, `action="/listings/${listingId}/chat"`);
      assert.include(seekerPageBefore.body, "Message lister");

      // Owner cannot open a chat with themselves.
      const selfAttempt = yield* send("POST", "/api/chats", {
        cookie: lister.cookie,
        payload: { listingId },
      });
      assert.strictEqual(selfAttempt.status, 400);

      // Cross-site form POST to listing CTA is refused.
      const crossSite = yield* call(
        `/listings/${listingId}/chat`,
        form(
          {
            method: "POST",
            headers: { cookie: seeker.cookie, origin: "https://evil.example" },
          },
          {},
        ),
      );
      assert.strictEqual(crossSite.status, 403);

      // Seeker submits the listing-detail CTA form -> 303 redirect into `/chats/:id`.
      const opened = yield* call(
        `/listings/${listingId}/chat`,
        form(
          {
            method: "POST",
            headers: { cookie: seeker.cookie, origin: testOrigin },
          },
          {},
        ),
      );
      assert.strictEqual(opened.status, 303, opened.body);
      assert.match(opened.location ?? "", /^\/chats\/[a-f0-9]+$/);
      const chatId = (opened.location ?? "").replace("/chats/", "");

      // Listing detail page now switches to "Open chat" linking to the existing chat.
      const seekerPageAfter = yield* call(`/listings/${listingId}`, {
        headers: { cookie: seeker.cookie },
      });
      assert.strictEqual(seekerPageAfter.status, 200);
      assert.include(seekerPageAfter.body, `href="/chats/${chatId}"`);
      assert.include(seekerPageAfter.body, "Open chat");

      // Opening again via JSON API returns the exact same chat id.
      const reopened = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId },
      });
      assert.strictEqual(reopened.status, 200, reopened.body);
      assert.strictEqual(asObject(reopened.json).id, chatId);
    }),
  );

  it.effect("orders messages monotonically, deduplicates clientMessageId, and replays gaps on reconnect", () =>
    Effect.gen(function* () {
      const lister = yield* register("chat-order-lister");
      const seeker = yield* register("chat-order-seeker");
      const listingId = yield* createPublishedListing(lister, "Ordering Test Studio");

      const opened = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId },
      });
      const chatId = asObject(opened.json).id as string;

      const wsSeeker = socketFrom101(yield* openSocket(chatId, seeker.cookie));
      const wsLister = socketFrom101(yield* openSocket(chatId, lister.cookie));

      // Ping/pong reports active connections.
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, { type: "ping" }),
      );
      const pong = wsSeeker.receivedJson().find((f) => f.type === "pong");
      assert.strictEqual(pong?.connections, 2);

      // Seeker sends 3 messages; lister sees seq 1, 2, 3 in strict order.
      for (let i = 1; i <= 3; i += 1) {
        yield* Effect.promise(() =>
          testChatNamespace.sendClientMessage(chatId, wsSeeker, {
            type: "send",
            clientMessageId: `msg-${i}`,
            body: `Hello #${i}`,
            // Spoofed senderId in payload must be completely ignored.
            senderId: lister.id,
          }),
        );
      }

      const listerLive = wsLister
        .receivedJson()
        .filter((f) => f.type === "message")
        .map((f) => f.message as Record<string, unknown>);
      assert.deepStrictEqual(
        listerLive.map((m) => m.seq),
        [1, 2, 3],
      );
      for (const m of listerLive) {
        assert.strictEqual(m.senderId, seeker.id);
      }

      // Lister disconnects; seeker sends 2 more messages (seq 4 and 5) and replays clientMessageId msg-4.
      yield* Effect.promise(() => testChatNamespace.closeClientSocket(chatId, wsLister));

      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "msg-4",
          body: "While offline #4",
        }),
      );
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "msg-5",
          body: "While offline #5",
        }),
      );
      // Replaying msg-4 produces no second row and returns seq 4.
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "msg-4",
          body: "While offline #4",
        }),
      );

      const rows = yield* query<{ seq: number; clientMessageId: string }>(
        "SELECT seq, client_message_id FROM chat_messages WHERE chat_id = ? ORDER BY seq ASC",
        [chatId],
      );
      assert.deepStrictEqual(
        rows.map((r) => r.seq),
        [1, 2, 3, 4, 5],
      );

      // Reconnecting via HTTP catch-up returns only seq 4 and 5.
      const httpCatchUp = yield* send("GET", `/api/chats/${chatId}/messages?after=3`, {
        cookie: lister.cookie,
      });
      assert.strictEqual(httpCatchUp.status, 200, httpCatchUp.body);
      const httpMsgs = (asObject(httpCatchUp.json).messages as ReadonlyArray<Record<string, unknown>>);
      assert.deepStrictEqual(
        httpMsgs.map((m) => m.seq),
        [4, 5],
      );

      // Reconnecting via WebSocket `?after=3` replays seq 4 and 5 only.
      const wsListerReconnected = socketFrom101(
        yield* openSocket(chatId, lister.cookie, "?after=3"),
      );
      const replayFrame = wsListerReconnected.receivedJson().find((f) => f.type === "replay");
      assert.isDefined(replayFrame);
      const replayed = (replayFrame?.messages as ReadonlyArray<Record<string, unknown>>) ?? [];
      assert.deepStrictEqual(
        replayed.map((m) => m.seq),
        [4, 5],
      );
    }),
  );

  it.effect("refuses non-participants, unauthenticated callers, cross-origin upgrades, and forged or expired tickets", () =>
    Effect.gen(function* () {
      const lister = yield* register("chat-auth-lister");
      const seeker = yield* register("chat-auth-seeker");
      const intruder = yield* register("chat-auth-intruder");
      const listingId = yield* createPublishedListing(lister, "Auth Guard Listing");

      const opened = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId },
      });
      const chatId = asObject(opened.json).id as string;

      // Unauthenticated socket -> 401.
      const unauthSocket = yield* callChatSocket(`/api/chats/${chatId}/socket`, {
        method: "GET",
        headers: { upgrade: "websocket" },
      });
      assert.strictEqual(unauthSocket.status, 401);

      // Non-participant -> 403 on socket, GET detail, GET messages, POST messages, POST read, and page.
      const intruderSocket = yield* openSocket(chatId, intruder.cookie);
      assert.strictEqual(intruderSocket.status, 403);
      assert.strictEqual((yield* send("GET", `/api/chats/${chatId}`, { cookie: intruder.cookie })).status, 403);
      assert.strictEqual((yield* send("GET", `/api/chats/${chatId}/messages`, { cookie: intruder.cookie })).status, 403);
      assert.strictEqual(
        (yield* send("POST", `/api/chats/${chatId}/messages`, {
          cookie: intruder.cookie,
          payload: { body: "Intruder message" },
        })).status,
        403,
      );
      assert.strictEqual(
        (yield* send("POST", `/api/chats/${chatId}/read`, {
          cookie: intruder.cookie,
          payload: {},
        })).status,
        403,
      );
      assert.strictEqual(
        (yield* call(`/chats/${chatId}`, { headers: { cookie: intruder.cookie } })).status,
        403,
      );

      // Cross-origin browser WebSocket upgrade is refused.
      const crossOriginSocket = yield* openSocket(chatId, seeker.cookie, "", {
        origin: "https://evil.example",
      });
      assert.strictEqual(crossOriginSocket.status, 403);

      // Tampered `?userId=` and forged `x-chat-ticket` / `x-user-id` headers are stripped by the Worker.
      const tamperedRes = yield* openSocket(
        chatId,
        seeker.cookie,
        `?userId=${encodeURIComponent(lister.id)}`,
        {
          "x-user-id": lister.id,
          [CHAT_TICKET_HEADER]: "v1.forged.ticket",
        },
      );
      const ws = socketFrom101(tamperedRes);
      const connected = ws.receivedJson().find((f) => f.type === "connected");
      assert.strictEqual(connected?.userId, seeker.id);

      // Directly calling the Durable Object with a forged, wrong-chat, or expired ticket returns 401.
      const stub = testChatNamespace.namespace.get(testChatNamespace.namespace.idFromName(chatId));
      const forgedDirect = yield* Effect.promise(() =>
        stub.fetch(
          new Request(`https://chat.internal/chats/${chatId}/socket`, {
            headers: {
              upgrade: "websocket",
              [CHAT_TICKET_HEADER]: "v1.e30.bad-signature",
            },
          }),
        ),
      );
      assert.strictEqual(forgedDirect.status, 401);

      const expiredTicket = yield* Effect.promise(() =>
        signChatTicket(testJwtSecret, {
          userId: seeker.id,
          chatId,
          exp: Math.floor(Date.now() / 1000) - 10,
        }),
      );
      const expiredDirect = yield* Effect.promise(() =>
        stub.fetch(
          new Request(`https://chat.internal/chats/${chatId}/socket`, {
            headers: {
              upgrade: "websocket",
              [CHAT_TICKET_HEADER]: expiredTicket,
            },
          }),
        ),
      );
      assert.strictEqual(expiredDirect.status, 401);

      const wrongChatTicket = yield* Effect.promise(() =>
        signChatTicket(testJwtSecret, {
          userId: seeker.id,
          chatId: "another-chat-id",
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      );
      const wrongChatDirect = yield* Effect.promise(() =>
        stub.fetch(
          new Request(`https://chat.internal/chats/${chatId}/socket`, {
            headers: {
              upgrade: "websocket",
              [CHAT_TICKET_HEADER]: wrongChatTicket,
            },
          }),
        ),
      );
      assert.strictEqual(wrongChatDirect.status, 401);
    }),
  );

  it.effect("rotates an expired access token via refresh_token on WebSocket upgrade and closes on expiry alarm", () =>
    Effect.gen(function* () {
      const lister = yield* register("chat-refresh-lister");
      const seeker = yield* register("chat-refresh-seeker");
      const listingId = yield* createPublishedListing(lister, "Refresh Rotation Studio");

      const opened = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId },
      });
      const chatId = asObject(opened.json).id as string;

      // Present only the refresh_token cookie (no access_token -> triggers rotation).
      const rotatedRes = yield* openSocket(chatId, `refresh_token=${seeker.refreshToken}`);
      const ws = socketFrom101(rotatedRes);
      const setCookies = rotatedRes.headers.getSetCookie();
      assert.isTrue(
        setCookies.some((c) => c.startsWith("access_token=")),
        `expected rotated access_token Set-Cookie, got ${setCookies.join(" | ")}`,
      );
      assert.isTrue(
        setCookies.some((c) => c.startsWith("refresh_token=")),
        `expected rotated refresh_token Set-Cookie, got ${setCookies.join(" | ")}`,
      );
      const connected = ws.receivedJson().find((f) => f.type === "connected");
      assert.strictEqual(connected?.userId, seeker.id);

      // Direct ticket with very short socketExp schedules alarm that closes socket with 4001.
      const stub = testChatNamespace.namespace.get(testChatNamespace.namespace.idFromName(chatId));
      const nowSec = Math.floor(Date.now() / 1000);
      const shortTicket = yield* Effect.promise(() =>
        signChatTicket(testJwtSecret, {
          userId: lister.id,
          chatId,
          exp: nowSec + 60,
          socketExp: nowSec + 1,
        }),
      );
      const shortRes = yield* Effect.promise(() =>
        stub.fetch(
          new Request(`https://chat.internal/chats/${chatId}/socket`, {
            headers: {
              upgrade: "websocket",
              [CHAT_TICKET_HEADER]: shortTicket,
            },
          }),
        ),
      );
      const shortWs = socketFrom101(shortRes);
      const { mockState } = testChatNamespace.getInstance(chatId);
      assert.isNotNull(mockState.getAlarm());

      // Wait just past the 1s expiry and trigger the DO alarm.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1100)));
      yield* Effect.promise(() => testChatNamespace.fireAlarm(chatId));
      assert.strictEqual(shortWs.readyState, 3);
      assert.strictEqual(shortWs.closedCode, CHAT_CLOSE_AUTH_EXPIRED);
    }),
  );

  it.effect("survives hibernation without losing seq ordering, attachments, or gap reconnect", () =>
    Effect.gen(function* () {
      const lister = yield* register("chat-hib-lister");
      const seeker = yield* register("chat-hib-seeker");
      const listingId = yield* createPublishedListing(lister, "Hibernation Safe Flat");

      const opened = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId },
      });
      const chatId = asObject(opened.json).id as string;

      const wsSeeker = socketFrom101(yield* openSocket(chatId, seeker.cookie));
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "hib-1",
          body: "Before sleep",
        }),
      );

      // Simulate hibernation: destroy the live Chat DO instance in memory while
      // preserving ctx.storage and accepted WebSockets.
      testChatNamespace.hibernate(chatId);

      // Wake the DO on the existing hibernated socket -> attachment + seq survive.
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "hib-2",
          body: "After wake",
        }),
      );

      const acks = wsSeeker
        .receivedJson()
        .filter((f) => f.type === "ack")
        .map((f) => (f.message as Record<string, unknown>).seq);
      assert.deepStrictEqual(acks, [1, 2]);

      // Lister reconnects after hibernation with `?after=1` and receives only seq 2.
      testChatNamespace.hibernate(chatId);
      const wsLister = socketFrom101(yield* openSocket(chatId, lister.cookie, "?after=1"));
      const replay = wsLister.receivedJson().find((f) => f.type === "replay");
      const replayed = (replay?.messages as ReadonlyArray<Record<string, unknown>>) ?? [];
      assert.deepStrictEqual(
        replayed.map((m) => ({ seq: m.seq, body: m.body })),
        [{ seq: 2, body: "After wake" }],
      );
    }),
  );

  it.effect("tracks unread counts in D1, clears them on read, broadcasts read event, and renders sign-in prompt when signed out", () =>
    Effect.gen(function* () {
      const lister = yield* register("chat-unread-lister");
      const seeker = yield* register("chat-unread-seeker");
      const listingId = yield* createPublishedListing(lister, "Unread Badge Flat");

      // Signed-out GET /chats renders HTML sign-in prompt rather than bare 401 text.
      const signedOut = yield* call("/chats");
      assert.strictEqual(signedOut.status, 401);
      assert.include(signedOut.body, "Sign in required");
      assert.notInclude(signedOut.body, "UnauthorizedError");

      const opened = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId },
      });
      const chatId = asObject(opened.json).id as string;

      const wsSeeker = socketFrom101(yield* openSocket(chatId, seeker.cookie));
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "u-1",
          body: "Is it still available?",
        }),
      );
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "u-2",
          body: "Can we view it tomorrow?",
        }),
      );

      // Lister's inbox reports unread 2 from D1.
      const inboxBefore = yield* send("GET", "/api/chats", { cookie: lister.cookie });
      assert.strictEqual(inboxBefore.status, 200, inboxBefore.body);
      const beforeObj = asObject(inboxBefore.json);
      assert.strictEqual(beforeObj.totalUnread, 2);
      const beforeItems = beforeObj.items as ReadonlyArray<Record<string, unknown>>;
      assert.strictEqual(beforeItems[0]?.unreadCount, 2);

      // Lister's HTML inbox page displays the unread badge.
      const inboxPage = yield* call("/chats", { headers: { cookie: lister.cookie } });
      assert.strictEqual(inboxPage.status, 200);
      assert.include(inboxPage.body, "2 unread messages");
      assert.include(inboxPage.body, `href="/chats/${chatId}"`);

      // Opening `/chats/:id` marks read in D1 and notifies seeker's live socket.
      const chatPage = yield* call(`/chats/${chatId}`, { headers: { cookie: lister.cookie } });
      assert.strictEqual(chatPage.status, 200);
      assert.include(chatPage.body, "Is it still available?");
      assert.include(chatPage.body, "Can we view it tomorrow?");

      const inboxAfter = yield* send("GET", "/api/chats", { cookie: lister.cookie });
      assert.strictEqual(asObject(inboxAfter.json).totalUnread, 0);

      const readFrame = wsSeeker.receivedJson().find((f) => f.type === "read");
      assert.isDefined(readFrame);
      assert.strictEqual(readFrame?.userId, lister.id);
      assert.strictEqual(readFrame?.lastReadSeq, 2);
    }),
  );

  it.effect("produces identical monotonic ordering between no-socket POST and WebSocket paths and enforces per-sender rate limits", () =>
    Effect.gen(function* () {
      const lister = yield* register("chat-parity-lister");
      const seeker = yield* register("chat-parity-seeker");
      const listingId = yield* createPublishedListing(lister, "POST Fallback Parity Flat");

      const opened = yield* send("POST", "/api/chats", {
        cookie: seeker.cookie,
        payload: { listingId },
      });
      const chatId = asObject(opened.json).id as string;

      const wsLister = socketFrom101(yield* openSocket(chatId, lister.cookie));
      const wsSeeker = socketFrom101(yield* openSocket(chatId, seeker.cookie));

      // 1. WebSocket send -> seq 1
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "mix-1",
          body: "From socket 1",
        }),
      );

      // 2. JSON POST fallback -> seq 2 (and fans out to live sockets!)
      const postRes = yield* send("POST", `/api/chats/${chatId}/messages`, {
        cookie: seeker.cookie,
        payload: { clientMessageId: "mix-2", body: "From JSON POST 2" },
      });
      assert.strictEqual(postRes.status, 200, postRes.body);
      assert.strictEqual(asObject(postRes.json).seq, 2);

      // 3. HTML form POST fallback -> seq 3
      const formRes = yield* call(
        `/chats/${chatId}/messages`,
        form(
          {
            method: "POST",
            headers: { cookie: seeker.cookie, origin: testOrigin },
          },
          { body: "From HTML form 3", clientMessageId: "mix-3" },
        ),
      );
      assert.strictEqual(formRes.status, 303);
      assert.strictEqual(formRes.location, `/chats/${chatId}`);

      // 4. WebSocket send -> seq 4
      yield* Effect.promise(() =>
        testChatNamespace.sendClientMessage(chatId, wsSeeker, {
          type: "send",
          clientMessageId: "mix-4",
          body: "From socket 4",
        }),
      );

      // Lister's live socket observed all 4 messages in exact order 1, 2, 3, 4.
      const listerObserved = wsLister
        .receivedJson()
        .filter((f) => f.type === "message")
        .map((f) => {
          const msg = f.message as Record<string, unknown>;
          return { seq: msg.seq, body: msg.body };
        });
      assert.deepStrictEqual(listerObserved, [
        { seq: 1, body: "From socket 1" },
        { seq: 2, body: "From JSON POST 2" },
        { seq: 3, body: "From HTML form 3" },
        { seq: 4, body: "From socket 4" },
      ]);

      // Rate limit check: default is 10 messages per minute per sender.
      // Seeker already sent 4; 6 more succeed (5..10), and the 11th returns 429.
      for (let i = 5; i <= 10; i += 1) {
        const res = yield* send("POST", `/api/chats/${chatId}/messages`, {
          cookie: seeker.cookie,
          payload: { clientMessageId: `mix-${i}`, body: `Burst #${i}` },
        });
        assert.strictEqual(res.status, 200, `message ${i}: ${res.body}`);
        assert.strictEqual(asObject(res.json).seq, i);
      }

      const rateLimited = yield* send("POST", `/api/chats/${chatId}/messages`, {
        cookie: seeker.cookie,
        payload: { clientMessageId: "mix-11", body: "Too fast" },
      });
      assert.strictEqual(rateLimited.status, 429, rateLimited.body);

      // Lister has an independent per-sender rate limit bucket and can still send.
      const listerReply = yield* send("POST", `/api/chats/${chatId}/messages`, {
        cookie: lister.cookie,
        payload: { clientMessageId: "lister-1", body: "Lister not rate-limited" },
      });
      assert.strictEqual(listerReply.status, 200, listerReply.body);
      assert.strictEqual(asObject(listerReply.json).seq, 11);
    }),
  );
});
