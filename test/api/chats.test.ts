import { CHAT_MESSAGE_MAX_LENGTH } from "@/db/schema/Chat";
import { asObject, call, form, register, send, testOrigin } from "../support/api";
import type { TestUser } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The chat HTTP surface, driven through the real private router over the
 * in-memory database: the page forms that start and reply to a chat, the JSON
 * inbox, one chat, its messages, the read acknowledgement, and the no-socket POST
 * path. The chat object is supplied by the harness's `ChatObject` layer, which verifies the same ticket the
 * Worker signs; the real object is exercised end to end by
 * `scripts/chat-socket-e2e.mjs`.
 */

const users = await Effect.runPromise(
  Effect.gen(function* () {
    const owner = yield* register("chat-owner");
    const seeker = yield* register("chat-seeker");
    const other = yield* register("chat-other");
    // A name on the owner's profile is what the other side's inbox shows.
    yield* send("PUT", "/api/users/profile", {
      cookie: owner.cookie,
      payload: { name: "Owner Name", dateOfBirth: 946684800000, gender: "NB" },
    });
    return { owner, seeker, other };
  }),
);

let counter = 0;

const listingPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: "room",
  title: `Chat fixture ${(counter += 1)}`,
  description: "A room to ask about",
  priceMinor: 120_000 + counter * 101,
  regionCode: "attica",
  sizeSqm: 30,
  furnished: 1,
  ensuite: 0,
  smoking: 0,
  pets: 1,
  ...overrides,
});

const createListing = (
  owner: TestUser,
  overrides: Record<string, unknown> = {},
  status: "draft" | "published" = "published",
) =>
  Effect.gen(function* () {
    const created = yield* send("POST", "/api/listings", {
      cookie: owner.cookie,
      payload: listingPayload(overrides),
    });
    assert.strictEqual(created.status, 200, `create listing: ${created.body}`);
    const listing = asObject(created.json);
    const id = Number(listing["id"]);
    if (status === "published") {
      const published = yield* send("POST", `/api/listings/${id}/publish`, {
        cookie: owner.cookie,
      });
      assert.strictEqual(published.status, 200, `publish listing: ${published.body}`);
    }
    return { id, title: String(listing["title"]) };
  });

const startChat = (
  seeker: TestUser,
  listingId: number,
  body: string,
  clientMessageId?: string,
) =>
  call(
    "/chats/start",
    form(
      { method: "POST", headers: { cookie: seeker.cookie, origin: testOrigin } },
      {
        listingId: String(listingId),
        body,
        ...(clientMessageId === undefined ? {} : { clientMessageId }),
      },
    ),
  );

const chatIdFrom = (location: string | null): number => {
  assert.isString(location);
  const id = Number(String(location).split("/").pop());
  assert.isTrue(Number.isSafeInteger(id) && id > 0, `chat id from ${String(location)}`);
  return id;
};

const inbox = (user: TestUser) =>
  Effect.gen(function* () {
    const response = yield* send("GET", "/api/chats", { cookie: user.cookie });
    assert.strictEqual(response.status, 200, `inbox: ${response.body}`);
    return asObject(response.json)["items"] as ReadonlyArray<Record<string, unknown>>;
  });

const messages = (user: TestUser, chatId: number, query = "") =>
  Effect.gen(function* () {
    const response = yield* send("GET", `/api/chats/${chatId}/messages${query}`, {
      cookie: user.cookie,
    });
    assert.strictEqual(response.status, 200, `messages: ${response.body}`);
    const body = asObject(response.json);
    return {
      lastSeq: Number(body["lastSeq"]),
      items: body["items"] as ReadonlyArray<Record<string, unknown>>,
    };
  });

const postMessage = (
  user: TestUser,
  chatId: number,
  payload: { body: string; clientMessageId?: string },
) => send("POST", `/api/chats/${chatId}/messages`, { cookie: user.cookie, payload });

const acknowledge = (user: TestUser, chatId: number, seq: number) =>
  send("POST", `/api/chats/${chatId}/read`, { cookie: user.cookie, payload: { seq } });

describe("starting a chat from a listing", () => {
  it.effect("opens the chat with the contact message as its first message", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner, { title: "Sunny room in Patisia" });
      const started = yield* startChat(users.seeker, listing.id, "Is the room still free?");
      assert.strictEqual(started.status, 303, `start chat: ${started.body}`);
      const chatId = chatIdFrom(started.location);

      const ownerInbox = yield* inbox(users.owner);
      const row = ownerInbox.find((item) => Number(item["id"]) === chatId);
      assert.isDefined(row, "the owner's inbox has the new chat");
      assert.strictEqual(row?.["unreadCount"], 1);
      assert.strictEqual(row?.["lastMessagePreview"], "Is the room still free?");
      assert.strictEqual(row?.["listingTitle"], "Sunny room in Patisia");
      assert.strictEqual(row?.["lastSeq"], 1);

      const seekerInbox = yield* inbox(users.seeker);
      const seekerRow = seekerInbox.find((item) => Number(item["id"]) === chatId);
      // The message is the seeker's own, so it is never unread to them.
      assert.strictEqual(seekerRow?.["unreadCount"], 0);
      assert.strictEqual(seekerRow?.["counterpartName"], "Owner Name");

      const page = yield* messages(users.owner, chatId);
      assert.strictEqual(page.lastSeq, 1);
      assert.strictEqual(page.items.length, 1);
      assert.strictEqual(page.items[0]?.["seq"], 1);
      assert.strictEqual(page.items[0]?.["body"], "Is the room still free?");
      assert.strictEqual(page.items[0]?.["senderId"], users.seeker.id);
    }),
  );

  it.effect("reopens the same chat and adds the message instead of a second thread", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const first = yield* startChat(users.seeker, listing.id, "Hello");
      const second = yield* startChat(users.seeker, listing.id, "One more thing");
      assert.strictEqual(first.status, 303);
      assert.strictEqual(second.status, 303);
      const chatId = chatIdFrom(first.location);
      assert.strictEqual(chatIdFrom(second.location), chatId);

      const page = yield* messages(users.seeker, chatId);
      assert.deepEqual(
        page.items.map((item) => item["seq"]),
        [1, 2],
      );
      const seekerInbox = yield* inbox(users.seeker);
      assert.strictEqual(seekerInbox.filter((item) => Number(item["id"]) === chatId).length, 1);
    }),
  );

  it.effect("writes one message when the contact form is submitted twice with the same id", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const first = yield* startChat(users.seeker, listing.id, "Double click", "contact-1");
      const second = yield* startChat(users.seeker, listing.id, "Double click", "contact-1");
      assert.strictEqual(first.status, 303, first.body);
      assert.strictEqual(second.status, 303, second.body);

      const chatId = chatIdFrom(first.location);
      assert.strictEqual(chatIdFrom(second.location), chatId);
      const page = yield* messages(users.seeker, chatId);
      assert.deepEqual(
        page.items.map((item) => item["body"]),
        ["Double click"],
      );
    }),
  );

  it.effect("refuses the owner's own listing and a listing that is not published", () =>
    Effect.gen(function* () {
      const mine = yield* createListing(users.owner);
      const own = yield* startChat(users.owner, mine.id, "Talking to myself");
      assert.strictEqual(own.status, 400, own.body);
      assert.include(own.body, "your own listing");

      const draft = yield* createListing(users.owner, {}, "draft");
      const unpublished = yield* startChat(users.seeker, draft.id, "Anyone there?");
      assert.strictEqual(unpublished.status, 404, unpublished.body);
      assert.include(unpublished.body, "no longer published");
    }),
  );
});

describe("the chat JSON API", () => {
  it.effect("clears the unread count when a chat is opened, and only for the reader", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Interested");
      const chatId = chatIdFrom(started.location);

      const before = yield* inbox(users.owner);
      assert.strictEqual(before.find((item) => Number(item["id"]) === chatId)?.["unreadCount"], 1);

      const opened = yield* send("GET", `/api/chats/${chatId}`, { cookie: users.owner.cookie });
      assert.strictEqual(opened.status, 200, opened.body);
      const detail = asObject(opened.json);
      assert.strictEqual(detail["lastReadSeq"], 1);
      assert.strictEqual((detail["participants"] as ReadonlyArray<unknown>).length, 2);

      const after = yield* inbox(users.owner);
      assert.strictEqual(after.find((item) => Number(item["id"]) === chatId)?.["unreadCount"], 0);
      // The seeker has not read the chat, but the owner's message is not unread
      // to the owner; nothing about the seeker's own inbox changed.
      const seekerRow = (yield* inbox(users.seeker)).find((item) => Number(item["id"]) === chatId);
      assert.strictEqual(seekerRow?.["unreadCount"], 0);
    }),
  );

  it.effect("advances the read mark only to the messages the reader reports seeing", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "First");
      const chatId = chatIdFrom(started.location);

      const opened = yield* send("GET", `/api/chats/${chatId}`, { cookie: users.owner.cookie });
      assert.strictEqual(opened.status, 200, opened.body);

      const second = yield* postMessage(users.seeker, chatId, {
        body: "Second",
        clientMessageId: "read-second",
      });
      assert.strictEqual(second.status, 200, second.body);

      const beforeAck = (yield* inbox(users.owner)).find(
        (item) => Number(item["id"]) === chatId,
      );
      assert.strictEqual(beforeAck?.["unreadCount"], 1);

      const stale = yield* acknowledge(users.owner, chatId, 1);
      assert.strictEqual(stale.status, 200, stale.body);
      assert.strictEqual(asObject(stale.json)["lastReadSeq"], 1);
      const stillUnread = (yield* inbox(users.owner)).find(
        (item) => Number(item["id"]) === chatId,
      );
      assert.strictEqual(stillUnread?.["unreadCount"], 1);

      const acknowledged = yield* acknowledge(users.owner, chatId, 2);
      assert.strictEqual(acknowledged.status, 200, acknowledged.body);
      assert.strictEqual(asObject(acknowledged.json)["lastReadSeq"], 2);
      const cleared = (yield* inbox(users.owner)).find((item) => Number(item["id"]) === chatId);
      assert.strictEqual(cleared?.["unreadCount"], 0);

      const ahead = yield* acknowledge(users.owner, chatId, 999);
      assert.strictEqual(asObject(ahead.json)["lastReadSeq"], 2);
      const third = yield* postMessage(users.seeker, chatId, {
        body: "Third",
        clientMessageId: "read-third",
      });
      assert.strictEqual(third.status, 200, third.body);
      const afterThird = (yield* inbox(users.owner)).find(
        (item) => Number(item["id"]) === chatId,
      );
      assert.strictEqual(afterThird?.["unreadCount"], 1);
    }),
  );

  it.effect("gives a reply the next sequence number and reads back in seq order", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "First");
      const chatId = chatIdFrom(started.location);

      const replyOne = yield* postMessage(users.owner, chatId, {
        body: "Second",
        clientMessageId: "owner-reply-1",
      });
      assert.strictEqual(replyOne.status, 200, replyOne.body);
      assert.strictEqual(asObject(replyOne.json)["seq"], 2);

      const replyTwo = yield* postMessage(users.owner, chatId, {
        body: "Third",
        clientMessageId: "owner-reply-2",
      });
      assert.strictEqual(replyTwo.status, 200, replyTwo.body);
      assert.strictEqual(asObject(replyTwo.json)["seq"], 3);

      const page = yield* messages(users.seeker, chatId);
      assert.strictEqual(page.lastSeq, 3);
      assert.deepEqual(
        page.items.map((item) => [item["seq"], item["body"]]),
        [
          [1, "First"],
          [2, "Second"],
          [3, "Third"],
        ],
      );

      // The gap path: a reconnecting client names the highest number it has.
      const missed = yield* messages(users.seeker, chatId, "?after=1");
      assert.deepEqual(
        missed.items.map((item) => item["seq"]),
        [2, 3],
      );
    }),
  );

  it.effect("answers a repeated client message id with the row it already wrote", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "One message");
      const chatId = chatIdFrom(started.location);

      const first = yield* postMessage(users.seeker, chatId, {
        body: "Sent twice by a retry",
        clientMessageId: "retry-me",
      });
      const second = yield* postMessage(users.seeker, chatId, {
        body: "Sent twice by a retry",
        clientMessageId: "retry-me",
      });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(asObject(first.json)["seq"], asObject(second.json)["seq"]);

      const page = yield* messages(users.seeker, chatId);
      assert.strictEqual(page.items.length, 2);
    }),
  );

  it.effect("stores the same client id from each participant as its own message", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Contact");
      const chatId = chatIdFrom(started.location);

      const fromSeeker = yield* postMessage(users.seeker, chatId, {
        body: "Seeker text",
        clientMessageId: "shared-id",
      });
      const fromOwner = yield* postMessage(users.owner, chatId, {
        body: "Owner text",
        clientMessageId: "shared-id",
      });
      assert.strictEqual(fromSeeker.status, 200, fromSeeker.body);
      assert.strictEqual(fromOwner.status, 200, fromOwner.body);
      assert.notStrictEqual(asObject(fromSeeker.json)["seq"], asObject(fromOwner.json)["seq"]);

      const page = yield* messages(users.seeker, chatId);
      assert.deepEqual(
        page.items.map((item) => [item["senderId"], item["body"]]),
        [
          [users.seeker.id, "Contact"],
          [users.seeker.id, "Seeker text"],
          [users.owner.id, "Owner text"],
        ],
      );
    }),
  );

  it.effect("refuses a blank message and an over-long one", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Hello");
      const chatId = chatIdFrom(started.location);

      const blank = yield* postMessage(users.seeker, chatId, { body: "   " });
      assert.strictEqual(blank.status, 400, blank.body);

      const long = yield* postMessage(users.seeker, chatId, { body: "x".repeat(4001) });
      assert.strictEqual(long.status, 400, long.body);

      const page = yield* messages(users.seeker, chatId);
      assert.strictEqual(page.items.length, 1);
    }),
  );

  it.effect("answers another account with the same 404 as a chat that does not exist", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Private");
      const chatId = chatIdFrom(started.location);

      for (const path of [
        `/api/chats/${chatId}`,
        `/api/chats/${chatId}/messages`,
        `/api/chats/${chatId + 999_999}`,
      ]) {
        const response = yield* send("GET", path, { cookie: users.other.cookie });
        assert.strictEqual(response.status, 404, `${path}: ${response.body}`);
      }

      const write = yield* postMessage(users.other, chatId, { body: "Butting in" });
      assert.strictEqual(write.status, 404, write.body);

      const read = yield* acknowledge(users.other, chatId, 1);
      assert.strictEqual(read.status, 404, read.body);

      assert.deepEqual(yield* inbox(users.other), []);
    }),
  );

  it.effect("refuses a signed-out caller", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Hello");
      const chatId = chatIdFrom(started.location);

      for (const path of [`/api/chats`, `/api/chats/${chatId}`, `/api/chats/${chatId}/messages`]) {
        const response = yield* call(path);
        assert.strictEqual(response.status, 401, `${path}: ${response.status}`);
      }

      const read = yield* send("POST", `/api/chats/${chatId}/read`, { payload: { seq: 1 } });
      assert.strictEqual(read.status, 401, read.body);
    }),
  );

  it.effect("refuses a cross-site send", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Hello");
      const chatId = chatIdFrom(started.location);

      const crossSite = yield* call(
        `/chats/${chatId}/messages`,
        form(
          {
            method: "POST",
            headers: { cookie: users.seeker.cookie, origin: "https://evil.example" },
          },
          { body: "Cross-site" },
        ),
      );
      assert.strictEqual(crossSite.status, 403, crossSite.body);

      const page = yield* messages(users.seeker, chatId);
      assert.strictEqual(page.items.length, 1);
    }),
  );
});

describe("the chat pages", () => {
  it.effect("renders the inbox with the counterpart, the listing and the unread badge", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner, { title: "Inbox page listing" });
      const started = yield* startChat(users.seeker, listing.id, "Inbox preview body");
      const chatId = chatIdFrom(started.location);

      const ownerInbox = yield* call("/chats", {
        headers: { cookie: users.owner.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(ownerInbox.status, 200, ownerInbox.body);
      assert.include(ownerInbox.body, "Inbox page listing");
      assert.include(ownerInbox.body, "Inbox preview body");
      assert.include(ownerInbox.body, `href="/chats/${chatId}"`);

      const empty = yield* call("/chats", {
        headers: { cookie: users.other.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(empty.status, 200);
      assert.include(empty.body, "No chats yet");
    }),
  );

  it.effect("renders one thread with its messages and the reply form", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(
        users.seeker,
        listing.id,
        "A message with <script>alert(1)</script> in it",
      );
      const chatId = chatIdFrom(started.location);

      const page = yield* call(`/chats/${chatId}`, {
        headers: { cookie: users.owner.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, `id="chat"`);
      assert.include(page.body, `data-chat-id="${chatId}"`);
      assert.include(page.body, `action="/chats/${chatId}/messages"`);
      assert.include(page.body, `data-seq="1"`);
      // The message is content, not markup.
      assert.notInclude(page.body, "<script>alert(1)</script>");
      assert.include(page.body, "&lt;script&gt;alert(1)&lt;/script&gt;");

      // Opening the thread is reading it, so the owner's badge clears.
      const ownerRow = (yield* inbox(users.owner)).find((item) => Number(item["id"]) === chatId);
      assert.strictEqual(ownerRow?.["unreadCount"], 0);
    }),
  );

  it.effect("sends from the page's form without a socket", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Hello from the form");
      const chatId = chatIdFrom(started.location);

      const sent = yield* call(
        `/chats/${chatId}/messages`,
        form(
          { method: "POST", headers: { cookie: users.owner.cookie, origin: testOrigin } },
          { body: "Reply from the form", clientMessageId: "form-reply-1" },
        ),
      );
      assert.strictEqual(sent.status, 303, sent.body);
      assert.strictEqual(sent.location, `/chats/${chatId}`);

      const page = yield* messages(users.seeker, chatId);
      assert.deepEqual(
        page.items.map((item) => item["body"]),
        ["Hello from the form", "Reply from the form"],
      );
    }),
  );

  it.effect("never shows either account's email as a chat label", () =>
    Effect.gen(function* () {
      const freshOwner = yield* register("chat-fresh-owner");
      const freshSeeker = yield* register("chat-fresh-seeker");
      const listing = yield* createListing(freshOwner);
      const started = yield* startChat(freshSeeker, listing.id, "No names here");
      const chatId = chatIdFrom(started.location);

      const ownerInbox = yield* call("/chats", {
        headers: { cookie: freshOwner.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(ownerInbox.status, 200, ownerInbox.body);
      assert.include(ownerInbox.body, "Member");
      assert.notInclude(ownerInbox.body, freshSeeker.email);
      assert.notInclude(ownerInbox.body, freshOwner.email);

      const thread = yield* call(`/chats/${chatId}`, {
        headers: { cookie: freshOwner.cookie, "user-agent": "estia-tests" },
      });
      assert.strictEqual(thread.status, 200, thread.body);
      assert.include(thread.body, "Member");
      assert.notInclude(thread.body, freshSeeker.email);
      assert.notInclude(thread.body, freshOwner.email);
    }),
  );

  it.effect("names the feature Chat on the inbox, thread and listing contact surfaces", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Chat naming");
      const chatId = chatIdFrom(started.location);

      const pages = [
        yield* call("/chats", {
          headers: { cookie: users.owner.cookie, "user-agent": "estia-tests" },
        }),
        yield* call(`/chats/${chatId}`, {
          headers: { cookie: users.owner.cookie, "user-agent": "estia-tests" },
        }),
        yield* call(`/listings/${listing.id}`, {
          headers: { cookie: users.seeker.cookie, "user-agent": "estia-tests" },
        }),
      ];

      for (const page of pages) {
        assert.strictEqual(page.status, 200, page.body);
        assert.include(page.body, "Chat");
        assert.notInclude(page.body.toLowerCase(), "conversation");
      }
    }),
  );

  it.effect("explains a rejected reply on the thread instead of dropping it", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Hello");
      const chatId = chatIdFrom(started.location);

      const refused = yield* call(
        `/chats/${chatId}/messages`,
        form(
          { method: "POST", headers: { cookie: users.owner.cookie, origin: testOrigin } },
          { body: "   " },
        ),
      );
      assert.strictEqual(refused.status, 400, refused.body);
      assert.include(refused.body, `1 to ${CHAT_MESSAGE_MAX_LENGTH} characters`);
    }),
  );

  it.effect("keeps the rejected text in the form when the reply is refused", () =>
    Effect.gen(function* () {
      const listing = yield* createListing(users.owner);
      const started = yield* startChat(users.seeker, listing.id, "Hello");
      const chatId = chatIdFrom(started.location);
      const draft = `draft-${"x".repeat(CHAT_MESSAGE_MAX_LENGTH)}`;

      const refused = yield* call(
        `/chats/${chatId}/messages`,
        form(
          { method: "POST", headers: { cookie: users.owner.cookie, origin: testOrigin } },
          { body: draft, clientMessageId: "too-long" },
        ),
      );
      assert.strictEqual(refused.status, 400, refused.body);
      assert.include(refused.body, draft);
    }),
  );

  it.effect("answers a signed-out visitor with the sign-in prompt page", () =>
    Effect.gen(function* () {
      const response = yield* call("/chats");
      assert.strictEqual(response.status, 401);
      assert.include(response.body, "Sign in");
    }),
  );
});
