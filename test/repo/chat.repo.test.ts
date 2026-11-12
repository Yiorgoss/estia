import { ChatId, ListingId, UserId } from "@/db/schema/brands";
import { ChatRepository, ChatRepositoryLive } from "@/repos/chat.repo";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import {
  insertChatMessage,
  insertLister,
  insertListing,
  insertSeeker,
  insertUser,
} from "../support/seed";
import { TestSqlLive } from "../support/sql";

/*
 * The chat repository's rules, over the real SQL schema: the thread key that
 * makes a second contact reopen the one that exists, the unread count that
 * excludes the reader's own messages, a read mark that only moves forward, and a
 * message page ordered by sequence number.
 */

const userId = (value: string) => Schema.decodeSync(UserId)(value);
const chatId = (value: number) => Schema.decodeSync(ChatId)(value);
const listingId = (value: number) => Schema.decodeSync(ListingId)(value);

const TestLive = Layer.merge(ChatRepositoryLive.pipe(Layer.provide(TestSqlLive)), TestSqlLive);

/*
 * An account with a profile name, so the inbox's name resolution has something
 * to find. `kind` decides which of the two profile tables the name lives in.
 */
const seedAccount = (id: string, name: string, kind: "seeker" | "lister", profileId: number) =>
  Effect.gen(function* () {
    yield* insertUser(id, `${id}@chat-repo.test`, kind);
    if (kind === "seeker") {
      yield* insertSeeker(id, { name });
    } else {
      yield* insertLister(profileId, id, { name });
    }
  });

layer(TestLive, { concurrent: false })("ChatRepository", (it) => {
  it.effect("findOrCreate answers with the same thread on a second open", () =>
    Effect.gen(function* () {
      yield* seedAccount("u-repo-owner", "Owner Name", "lister", 1);
      yield* seedAccount("u-repo-seeker", "Seeker Name", "seeker", 1);
      yield* insertListing(1, "u-repo-owner", { status: "published" });
      const repo = yield* ChatRepository;

      const first = yield* repo.findOrCreate({
        listingId: listingId(1),
        seekerUserId: userId("u-repo-seeker"),
        listerUserId: userId("u-repo-owner"),
      });
      const second = yield* repo.findOrCreate({
        listingId: listingId(1),
        seekerUserId: userId("u-repo-seeker"),
        listerUserId: userId("u-repo-owner"),
      });

      assert.strictEqual(first.id, second.id);
      assert.strictEqual(first.listingId, 1);
      assert.strictEqual(first.seekerUserId, "u-repo-seeker");
      assert.strictEqual(first.listerUserId, "u-repo-owner");
      assert.strictEqual(first.lastSeq, 0);
      assert.isNull(first.lastMessageAt);

      const participants = yield* repo.listParticipants(first.id);
      assert.deepEqual(
        participants.map((participant) => [participant.userId, participant.name]),
        [
          ["u-repo-owner", "Owner Name"],
          ["u-repo-seeker", "Seeker Name"],
        ],
      );
    }),
  );

  it.effect("gives each person their own thread per listing", () =>
    Effect.gen(function* () {
      yield* seedAccount("u-repo-owner2", "Owner Two", "lister", 2);
      yield* seedAccount("u-repo-a", "Person A", "seeker", 1);
      yield* seedAccount("u-repo-b", "Person B", "seeker", 2);
      yield* insertListing(2, "u-repo-owner2", { status: "published" });
      const repo = yield* ChatRepository;

      const one = yield* repo.findOrCreate({
        listingId: listingId(2),
        seekerUserId: userId("u-repo-a"),
        listerUserId: userId("u-repo-owner2"),
      });
      const two = yield* repo.findOrCreate({
        listingId: listingId(2),
        seekerUserId: userId("u-repo-b"),
        listerUserId: userId("u-repo-owner2"),
      });

      assert.notStrictEqual(one.id, two.id);
    }),
  );

  it.effect("counts the other side's messages above the read mark as unread", () =>
    Effect.gen(function* () {
      yield* seedAccount("u-unread-owner", "Owner", "lister", 3);
      yield* seedAccount("u-unread-seeker", "Asker", "seeker", 3);
      yield* insertListing(3, "u-unread-owner", { status: "published", title: "Unread listing" });
      const repo = yield* ChatRepository;

      const chat = yield* repo.findOrCreate({
        listingId: listingId(3),
        seekerUserId: userId("u-unread-seeker"),
        listerUserId: userId("u-unread-owner"),
      });
      yield* insertChatMessage({
        chatId: chat.id,
        seq: 1,
        senderId: "u-unread-seeker",
        body: "first from the asker",
        clientMessageId: "m-1",
      });
      yield* insertChatMessage({
        chatId: chat.id,
        seq: 2,
        senderId: "u-unread-owner",
        body: "reply from the owner",
        clientMessageId: "m-2",
      });
      yield* insertChatMessage({
        chatId: chat.id,
        seq: 3,
        senderId: "u-unread-seeker",
        body: "second from the asker",
        clientMessageId: "m-3",
      });

      const ownerInbox = yield* repo.listInbox(userId("u-unread-owner"), 10);
      assert.strictEqual(ownerInbox.length, 1);
      assert.strictEqual(ownerInbox[0]?.unreadCount, 2);
      assert.strictEqual(ownerInbox[0]?.counterpartName, "Asker");
      assert.strictEqual(ownerInbox[0]?.listingTitle, "Unread listing");
      assert.strictEqual(ownerInbox[0]?.lastMessagePreview, "second from the asker");
      assert.strictEqual(ownerInbox[0]?.lastSeq, 3);

      const seekerInbox = yield* repo.listInbox(userId("u-unread-seeker"), 10);
      assert.strictEqual(seekerInbox[0]?.unreadCount, 1);
      assert.strictEqual(seekerInbox[0]?.counterpartName, "Owner");

      yield* repo.markRead(chatId(chat.id), userId("u-unread-owner"), 2);
      const afterReading = yield* repo.listInbox(userId("u-unread-owner"), 10);
      assert.strictEqual(afterReading[0]?.unreadCount, 1);

      const access = yield* repo.findForUser(chatId(chat.id), userId("u-unread-owner"));
      assert.isTrue(Option.isSome(access));
      assert.strictEqual(Option.getOrThrow(access).lastReadSeq, 2);
    }),
  );

  it.effect("uses a neutral label when no profile carries a name", () =>
    Effect.gen(function* () {
      // Registration creates the profile rows without a name; the chat must not
      // fall back to either account's email.
      yield* insertUser("u-noname-owner", "noname-owner@chat-repo.test", "lister");
      yield* insertUser("u-noname-seeker", "noname-seeker@chat-repo.test", "seeker");
      yield* insertListing(9, "u-noname-owner", { status: "published" });
      const repo = yield* ChatRepository;

      const chat = yield* repo.findOrCreate({
        listingId: listingId(9),
        seekerUserId: userId("u-noname-seeker"),
        listerUserId: userId("u-noname-owner"),
      });
      yield* insertChatMessage({
        chatId: chat.id,
        seq: 1,
        senderId: "u-noname-seeker",
        body: "hello",
        clientMessageId: "n-1",
      });

      const ownerInbox = yield* repo.listInbox(userId("u-noname-owner"), 10);
      assert.strictEqual(ownerInbox[0]?.counterpartName, "Member");

      const seekerInbox = yield* repo.listInbox(userId("u-noname-seeker"), 10);
      assert.strictEqual(seekerInbox[0]?.counterpartName, "Member");

      const participants = yield* repo.listParticipants(chat.id);
      assert.deepEqual(
        participants.map((participant) => participant.name),
        ["Member", "Member"],
      );
    }),
  );

  it.effect("never moves a read mark backwards", () =>
    Effect.gen(function* () {
      yield* seedAccount("u-mark-owner", "Owner", "lister", 4);
      yield* seedAccount("u-mark-seeker", "Asker", "seeker", 4);
      yield* insertListing(4, "u-mark-owner", { status: "published" });
      const repo = yield* ChatRepository;

      const chat = yield* repo.findOrCreate({
        listingId: listingId(4),
        seekerUserId: userId("u-mark-seeker"),
        listerUserId: userId("u-mark-owner"),
      });
      yield* repo.markRead(chatId(chat.id), userId("u-mark-owner"), 5);
      yield* repo.markRead(chatId(chat.id), userId("u-mark-owner"), 2);

      const access = yield* repo.findForUser(chatId(chat.id), userId("u-mark-owner"));
      assert.strictEqual(Option.getOrThrow(access).lastReadSeq, 5);
    }),
  );

  it.effect("pages the archive by sequence number, not by insertion order", () =>
    Effect.gen(function* () {
      yield* seedAccount("u-page-owner", "Owner", "lister", 5);
      yield* seedAccount("u-page-seeker", "Asker", "seeker", 5);
      yield* insertListing(5, "u-page-owner", { status: "published" });
      const repo = yield* ChatRepository;

      const chat = yield* repo.findOrCreate({
        listingId: listingId(5),
        seekerUserId: userId("u-page-seeker"),
        listerUserId: userId("u-page-owner"),
      });
      // Deliberately written out of order: the archive's order is `seq`.
      yield* insertChatMessage({
        chatId: chat.id,
        seq: 2,
        senderId: "u-page-owner",
        body: "second",
        clientMessageId: "p-2",
      });
      yield* insertChatMessage({
        chatId: chat.id,
        seq: 1,
        senderId: "u-page-seeker",
        body: "first",
        clientMessageId: "p-1",
      });
      yield* insertChatMessage({
        chatId: chat.id,
        seq: 3,
        senderId: "u-page-seeker",
        body: "third",
        clientMessageId: "p-3",
      });

      const all = yield* repo.listMessages(chatId(chat.id), 0, 10);
      assert.deepEqual(
        all.map((message) => [message.seq, message.body]),
        [
          [1, "first"],
          [2, "second"],
          [3, "third"],
        ],
      );

      const afterFirst = yield* repo.listMessages(chatId(chat.id), 1, 10);
      assert.deepEqual(
        afterFirst.map((message) => message.seq),
        [2, 3],
      );

      const limited = yield* repo.listMessages(chatId(chat.id), 1, 1);
      assert.deepEqual(
        limited.map((message) => message.seq),
        [2],
      );

      const beforeThird = yield* repo.listBefore(chatId(chat.id), 3, 10);
      assert.deepEqual(
        beforeThird.map((message) => message.seq),
        [1, 2],
      );

      const nearestBeforeFourth = yield* repo.listBefore(chatId(chat.id), 4, 2);
      assert.deepEqual(
        nearestBeforeFourth.map((message) => message.seq),
        [2, 3],
      );

      assert.deepEqual(yield* repo.listBefore(chatId(chat.id), 1, 10), []);
    }),
  );

  it.effect("answers a non-participant with nothing at all", () =>
    Effect.gen(function* () {
      yield* seedAccount("u-out-owner", "Owner", "lister", 6);
      yield* seedAccount("u-out-seeker", "Asker", "seeker", 6);
      yield* seedAccount("u-out-stranger", "Stranger", "seeker", 7);
      yield* insertListing(6, "u-out-owner", { status: "published" });
      const repo = yield* ChatRepository;

      const chat = yield* repo.findOrCreate({
        listingId: listingId(6),
        seekerUserId: userId("u-out-seeker"),
        listerUserId: userId("u-out-owner"),
      });

      assert.isFalse(yield* repo.isParticipant(chatId(chat.id), userId("u-out-stranger")));
      assert.isTrue(yield* repo.isParticipant(chatId(chat.id), userId("u-out-seeker")));
      assert.isTrue(
        Option.isNone(yield* repo.findForUser(chatId(chat.id), userId("u-out-stranger"))),
      );
      assert.deepEqual(yield* repo.listInbox(userId("u-out-stranger"), 10), []);
    }),
  );

  it.effect("orders the inbox by the latest activity", () =>
    Effect.gen(function* () {
      yield* seedAccount("u-order-owner", "Owner", "lister", 8);
      yield* seedAccount("u-order-a", "Person A", "seeker", 8);
      yield* seedAccount("u-order-b", "Person B", "seeker", 9);
      yield* insertListing(7, "u-order-owner", { status: "published", title: "First listing" });
      yield* insertListing(8, "u-order-owner", { status: "published", title: "Second listing" });
      const repo = yield* ChatRepository;

      const first = yield* repo.findOrCreate({
        listingId: listingId(7),
        seekerUserId: userId("u-order-a"),
        listerUserId: userId("u-order-owner"),
      });
      const second = yield* repo.findOrCreate({
        listingId: listingId(8),
        seekerUserId: userId("u-order-b"),
        listerUserId: userId("u-order-owner"),
      });
      yield* insertChatMessage({
        chatId: first.id,
        seq: 1,
        senderId: "u-order-a",
        body: "older activity",
        clientMessageId: "o-1",
        createdAt: 1_700_000_001_000,
      });
      yield* insertChatMessage({
        chatId: second.id,
        seq: 1,
        senderId: "u-order-b",
        body: "newer activity",
        clientMessageId: "o-2",
        createdAt: 1_700_000_009_000,
      });

      const inbox = yield* repo.listInbox(userId("u-order-owner"), 10);
      assert.deepEqual(
        inbox.map((item) => item.listingTitle),
        ["Second listing", "First listing"],
      );
    }),
  );
});
