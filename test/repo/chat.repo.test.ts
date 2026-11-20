import { ChatId, ListingId, UserId } from "@/db/schema/brands";
import { ChatRepository, ChatRepositoryLive, LIST_INBOX_FOR_USER_SQL } from "@/repos/chat.repo";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { insertListing, insertLister, insertSeeker, insertUser } from "../support/seed";
import { TestSqlLive } from "../support/sql";

const TestLayer = ChatRepositoryLive.pipe(Layer.provideMerge(TestSqlLive));

const uid = (value: string) => Schema.decodeSync(UserId)(value);
const lid = (value: number) => Schema.decodeSync(ListingId)(value);
const cid = (value: string) => Schema.decodeSync(ChatId)(value);

const seedUsersAndListing = Effect.gen(function* () {
  yield* insertUser("u-lister", "lister@test.local", "lister");
  yield* insertLister(1, "u-lister", { name: "Nikos" });
  yield* insertUser("u-seeker", "seeker@test.local", "seeker");
  yield* insertSeeker("u-seeker", { name: "Eleni" });
  yield* insertUser("u-other", "other@test.local", "seeker");
  yield* insertSeeker("u-other", { name: "Giorgos" });
  yield* insertListing(101, "u-lister", {
    status: "published",
    title: "Bright flat in Kolonaki",
    regionCode: "attica",
    priceMinor: 95_000,
  });
});

describe("ChatRepository", () => {
  it.effect("opens a chat once per (listing, seeker) pair and returns the same row on retry", () =>
    Effect.gen(function* () {
      yield* seedUsersAndListing;
      const repo = yield* ChatRepository;

      const first = yield* repo.openOrFind(lid(101), uid("u-seeker"), uid("u-lister"));
      const second = yield* repo.openOrFind(lid(101), uid("u-seeker"), uid("u-lister"));

      assert.strictEqual(second.id, first.id);
      assert.strictEqual(first.listingId, lid(101));
      assert.strictEqual(first.seekerId, uid("u-seeker"));
      assert.strictEqual(first.listerId, uid("u-lister"));

      assert.isTrue(yield* repo.isParticipant(first.id, uid("u-seeker")));
      assert.isTrue(yield* repo.isParticipant(first.id, uid("u-lister")));
      assert.isFalse(yield* repo.isParticipant(first.id, uid("u-other")));

      const found = yield* repo.findByListingAndSeeker(lid(101), uid("u-seeker"));
      assert.isTrue(Option.isSome(found));
      assert.strictEqual(Option.getOrThrow(found).id, first.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "enforces unique indexes on (chat_id, seq) and (chat_id, client_message_id) and rejects self-chat",
    () =>
      Effect.gen(function* () {
        yield* seedUsersAndListing;
        const repo = yield* ChatRepository;
        const sql = yield* SqlClient.SqlClient;

        const chat = yield* repo.openOrFind(lid(101), uid("u-seeker"), uid("u-lister"));

        // Self-chat is refused by the database CHECK constraint.
        const selfExit = yield* Effect.exit(
          sql.unsafe(
            "INSERT INTO chats (id, listing_id, seeker_id, lister_id) VALUES (?, ?, ?, ?)",
            ["self-chat-id", 101, "u-lister", "u-lister"],
          ),
        );
        assert.strictEqual(selfExit._tag, "Failure");

        // Insert message seq=1 with client_message_id='m-1'.
        yield* sql.unsafe(
          "INSERT INTO chat_messages (chat_id, seq, sender_id, client_message_id, body) VALUES (?, ?, ?, ?, ?)",
          [chat.id, 1, "u-seeker", "m-1", "Hello"],
        );

        // Duplicate (chat_id, seq) is rejected by idx_chat_messages_chat_seq.
        const dupSeqExit = yield* Effect.exit(
          sql.unsafe(
            "INSERT INTO chat_messages (chat_id, seq, sender_id, client_message_id, body) VALUES (?, ?, ?, ?, ?)",
            [chat.id, 1, "u-lister", "m-2", "Clash seq"],
          ),
        );
        assert.strictEqual(dupSeqExit._tag, "Failure");

        // Duplicate (chat_id, client_message_id) is rejected by idx_chat_messages_chat_client_id.
        const dupClientExit = yield* Effect.exit(
          sql.unsafe(
            "INSERT INTO chat_messages (chat_id, seq, sender_id, client_message_id, body) VALUES (?, ?, ?, ?, ?)",
            [chat.id, 2, "u-seeker", "m-1", "Duplicate retry"],
          ),
        );
        assert.strictEqual(dupClientExit._tag, "Failure");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("inbox query uses idx_chat_participants_inbox and never scans chat_messages", () =>
    Effect.gen(function* () {
      yield* seedUsersAndListing;
      const repo = yield* ChatRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repo.openOrFind(lid(101), uid("u-seeker"), uid("u-lister"));

      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${LIST_INBOX_FOR_USER_SQL}`,
        ["u-seeker"],
      );

      const details = plan.map((row) => row.detail).join("\n");
      assert.include(details, "idx_chat_participants_inbox");
      assert.notInclude(details, "chat_messages");
      assert.notInclude(details, "TEMP B-TREE");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("lists the most recent message window in ascending seq order", () =>
    Effect.gen(function* () {
      yield* seedUsersAndListing;
      const repo = yield* ChatRepository;
      const sql = yield* SqlClient.SqlClient;

      const chat = yield* repo.openOrFind(lid(101), uid("u-seeker"), uid("u-lister"));
      for (let seq = 1; seq <= 5; seq += 1) {
        yield* sql.unsafe(
          "INSERT INTO chat_messages (chat_id, seq, sender_id, client_message_id, body) VALUES (?, ?, ?, ?, ?)",
          [chat.id, seq, "u-seeker", `r-${seq}`, `Message #${seq}`],
        );
      }

      const recent = yield* repo.listRecentMessages(cid(chat.id), 3);
      assert.isTrue(recent.hasMore);
      assert.deepStrictEqual(
        recent.messages.map((m) => m.seq),
        [3, 4, 5],
      );

      const all = yield* repo.listRecentMessages(cid(chat.id), 10);
      assert.isFalse(all.hasMore);
      assert.deepStrictEqual(
        all.messages.map((m) => m.seq),
        [1, 2, 3, 4, 5],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("lists inbox with counterpart profile names and clears unread count on markRead", () =>
    Effect.gen(function* () {
      yield* seedUsersAndListing;
      const repo = yield* ChatRepository;
      const sql = yield* SqlClient.SqlClient;

      const chat = yield* repo.openOrFind(lid(101), uid("u-seeker"), uid("u-lister"));
      const now = 1_750_000_000_000;

      // Simulate two messages from seeker to lister.
      yield* sql.unsafe(
        `INSERT INTO chat_messages (chat_id, seq, sender_id, client_message_id, body, created_at)
         VALUES (?, 1, 'u-seeker', 'c-1', 'First', ?), (?, 2, 'u-seeker', 'c-2', 'Second', ?)`,
        [chat.id, now, chat.id, now + 1000],
      );
      yield* sql.unsafe(
        `UPDATE chats
            SET last_seq = 2, last_message_body = 'Second', last_message_sender_id = 'u-seeker', last_message_at = ?
          WHERE id = ?`,
        [now + 1000, chat.id],
      );
      yield* sql.unsafe(
        `UPDATE chat_participants SET last_seq = 2, last_message_at = ?, last_read_seq = 2, unread_count = 0
          WHERE chat_id = ? AND user_id = 'u-seeker'`,
        [now + 1000, chat.id],
      );
      yield* sql.unsafe(
        `UPDATE chat_participants SET last_seq = 2, last_message_at = ?, unread_count = 2
          WHERE chat_id = ? AND user_id = 'u-lister'`,
        [now + 1000, chat.id],
      );

      const listerInbox = yield* repo.listInboxForUser(uid("u-lister"));
      assert.lengthOf(listerInbox, 1);
      assert.strictEqual(listerInbox[0]?.counterpartName, "Eleni");
      assert.strictEqual(listerInbox[0]?.unreadCount, 2);
      assert.strictEqual(listerInbox[0]?.lastSeq, 2);

      const seekerInbox = yield* repo.listInboxForUser(uid("u-seeker"));
      assert.lengthOf(seekerInbox, 1);
      assert.strictEqual(seekerInbox[0]?.counterpartName, "Nikos");
      assert.strictEqual(seekerInbox[0]?.unreadCount, 0);

      // Partial markRead to seq 1 leaves 1 unread.
      const partial = yield* repo.markRead(cid(chat.id), uid("u-lister"), 1);
      assert.strictEqual(partial.lastReadSeq, 1);
      assert.strictEqual(partial.unreadCount, 1);

      // Full markRead clears unread to 0 and never moves backwards.
      const full = yield* repo.markRead(cid(chat.id), uid("u-lister"));
      assert.strictEqual(full.lastReadSeq, 2);
      assert.strictEqual(full.unreadCount, 0);

      const backwards = yield* repo.markRead(cid(chat.id), uid("u-lister"), 1);
      assert.strictEqual(backwards.lastReadSeq, 2);
      assert.strictEqual(backwards.unreadCount, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
