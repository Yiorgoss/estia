import { ChatId, ListingId, UserId } from "@/db/schema/brands";
import {
  ChatInboxItemSchema,
  ChatMessageSchema,
  ChatParticipantSchema,
  ChatSchema,
} from "@/db/schema/Chat";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The chat repository. Every read answers only what the caller may see: an inbox
 * row is chosen by the caller's own participant row, and a message page is chosen
 * by a chat id the service has already proved the caller belongs to. A chat id
 * alone never authorises a read.
 *
 * Like the other repositories this is single-statement only - D1 has no
 * interactive transaction through this driver - so the one place that needs two
 * writes (`findOrCreate`) explains why the second one is idempotent.
 *
 * The chat object writes `chat_messages` and the chat's `last_seq`; this module
 * only reads them. The object cannot use this repository: it runs outside the
 * Effect runtime and talks to D1 through its own small store in
 * `src/durable-objects/chat.ts`.
 */

/*
 * The name a person is shown under. A participant holds one profile kind and a
 * profile row can exist before a name is filled in, so the expression falls back
 * to the account's own email - the identity the two sides already exchanged when
 * the chat started - and only then to a stand-in. The expression is raw SQL, so
 * it is passed as a literal: a `sql` interpolation would send it as a bound value.
 */
const PARTICIPANT_NAME = "COALESCE(s.name, li.name, u.email, 'Member')";

const participantJoins = (userAlias: string) => `
  LEFT JOIN seekers AS s ON s.user_id = ${userAlias}.user_id
  LEFT JOIN listers AS li ON li.user_id = ${userAlias}.user_id
  LEFT JOIN users AS u ON u.id = ${userAlias}.user_id`;

export interface ChatRepository {
  /*
   * The thread for one listing and one person who asked about it. Pressing the
   * contact control twice answers with the thread that already exists instead of
   * a second one - the table's `UNIQUE (listing_id, seeker_user_id)` is what makes
   * that true even when two requests arrive together.
   */
  readonly findOrCreate: (values: {
    readonly listingId: typeof ListingId.Type;
    readonly seekerUserId: typeof UserId.Type;
    readonly listerUserId: typeof UserId.Type;
  }) => Effect.Effect<typeof ChatSchema.Type, SqlError>;

  /*
   * One chat the caller belongs to, with the listing title and the caller's own
   * read mark. `None` is the answer for an unknown chat and for another account's
   * chat alike: the service never tells a caller which of the two it was.
   */
  readonly findForUser: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<typeof ChatAccessSchema.Type>, SqlError>;

  readonly isParticipant: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
  ) => Effect.Effect<boolean, SqlError>;

  readonly listInbox: (
    userId: typeof UserId.Type,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<typeof ChatInboxItemSchema.Type>, SqlError>;

  readonly listParticipants: (
    chatId: typeof ChatId.Type,
  ) => Effect.Effect<ReadonlyArray<typeof ChatParticipantSchema.Type>, SqlError>;

  /*
   * The archive from after a sequence number, oldest first. It is the same page
   * whether a page renders it or an API client catches up after a reconnect.
   */
  readonly listMessages: (
    chatId: typeof ChatId.Type,
    afterSeq: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<typeof ChatMessageSchema.Type>, SqlError>;

  /*
   * Moves the caller's read mark forward, never backwards: opening an older page
   * after a newer one does not make anything unread again.
   */
  readonly markRead: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
    seq: number,
  ) => Effect.Effect<void, SqlError>;
}

/*
 * A chat plus the membership facts the service needs: the listing's title, which
 * the inbox row and the thread header both carry, and the caller's read mark.
 */
export const ChatAccessSchema = Schema.Struct({
  id: ChatId,
  listingId: ListingId,
  seekerUserId: UserId,
  listerUserId: UserId,
  lastSeq: Schema.Int,
  lastMessageAt: Schema.NullishOr(Schema.DateFromMillis),
  createdAt: Schema.DateFromMillis,
  listingTitle: Schema.String,
  lastReadSeq: Schema.Int,
});
export type ChatAccess = typeof ChatAccessSchema.Type;

export const ChatRepository = Context.Service<ChatRepository>("ChatRepository");

const decode = <A>(schema: Schema.Codec<A, unknown>, row: Record<string, unknown>): A =>
  Schema.decodeUnknownSync(schema)(row);

export const ChatRepositoryLive = Layer.effect(
  ChatRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      findOrCreate: (values) =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
              INSERT INTO chats (listing_id, seeker_user_id, lister_user_id)
              VALUES (${values.listingId}, ${values.seekerUserId}, ${values.listerUserId})
              ON CONFLICT (listing_id, seeker_user_id) DO UPDATE
                 SET listing_id = excluded.listing_id
              RETURNING *;
          `;
          const chat = decode(ChatSchema, Option.getOrThrow(Option.fromNullishOr(rows[0])));

          /*
           * The two membership rows are written with `INSERT OR IGNORE`, so a
           * second open of the same thread adds nothing. This is the one place
           * with two statements: a failure between them leaves a chat without its
           * membership rows, which the next open repairs, and the alternative -
           * an interactive transaction - does not exist on this driver.
           */
          yield* sql`
              INSERT OR IGNORE INTO chat_participants (chat_id, user_id)
              VALUES (${chat.id}, ${values.seekerUserId}), (${chat.id}, ${values.listerUserId});
          `;
          return chat;
        }),

      findForUser: (chatId, userId) =>
        sql<Record<string, unknown>>`
            SELECT c.id, c.listing_id, c.seeker_user_id, c.lister_user_id, c.last_seq,
                   c.last_message_at, c.created_at, l.title AS listing_title, p.last_read_seq
              FROM chats AS c
              JOIN chat_participants AS p ON p.chat_id = c.id AND p.user_id = ${userId}
              JOIN listings AS l ON l.id = c.listing_id
             WHERE c.id = ${chatId}
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map((row) => decode(ChatAccessSchema, row))),
        ),

      isParticipant: (chatId, userId) =>
        sql<Record<string, unknown>>`
            SELECT 1 AS present
              FROM chat_participants
             WHERE chat_id = ${chatId}
               AND user_id = ${userId}
            `.pipe(Effect.map((rows) => rows.length > 0)),

      /*
       * The inbox is one query, and the unread count comes from the caller's own
       * read mark against the other side's messages. A message the caller sent is
       * never unread to them, and no answer here needs the chat object.
       */
      listInbox: (userId, limit) =>
        sql<Record<string, unknown>>`
            SELECT c.id, c.listing_id, c.last_seq, c.last_message_at, c.created_at,
                   l.title AS listing_title,
                   other.user_id AS counterpart_user_id,
                   ${sql.literal(PARTICIPANT_NAME)} AS counterpart_name,
                   (SELECT COUNT(*)
                      FROM chat_messages AS m
                     WHERE m.chat_id = c.id
                       AND m.seq > p.last_read_seq
                       AND m.sender_id <> p.user_id) AS unread_count,
                   (SELECT m.body
                      FROM chat_messages AS m
                     WHERE m.chat_id = c.id
                  ORDER BY m.seq DESC
                     LIMIT 1) AS last_message_preview
              FROM chats AS c
              JOIN chat_participants AS p ON p.chat_id = c.id AND p.user_id = ${userId}
              JOIN listings AS l ON l.id = c.listing_id
              JOIN chat_participants AS other ON other.chat_id = c.id AND other.user_id <> p.user_id
              ${sql.literal(participantJoins("other"))}
             ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
             LIMIT ${limit}
            `.pipe(Effect.map((rows) => rows.map((row) => decode(ChatInboxItemSchema, row)))),

      listParticipants: (chatId) =>
        sql<Record<string, unknown>>`
            SELECT p.user_id, p.last_read_seq, ${sql.literal(PARTICIPANT_NAME)} AS name
              FROM chat_participants AS p${sql.literal(participantJoins("p"))}
             WHERE p.chat_id = ${chatId}
             ORDER BY p.user_id ASC
            `.pipe(Effect.map((rows) => rows.map((row) => decode(ChatParticipantSchema, row)))),

      listMessages: (chatId, afterSeq, limit) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM chat_messages
             WHERE chat_id = ${chatId}
               AND seq > ${afterSeq}
          ORDER BY seq ASC
             LIMIT ${limit}
            `.pipe(Effect.map((rows) => rows.map((row) => decode(ChatMessageSchema, row)))),

      markRead: (chatId, userId, seq) =>
        Effect.asVoid(
          sql`
            UPDATE chat_participants
               SET last_read_seq = MAX(last_read_seq, ${seq})
             WHERE chat_id = ${chatId}
               AND user_id = ${userId};
          `,
        ),
    } satisfies ChatRepository;
  }).pipe(Effect.tapError((error) => Effect.logError("Chat repository failed", { error }))),
);
