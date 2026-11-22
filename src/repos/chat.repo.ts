import { ChatId, ListingId, UserId } from "@/db/schema/brands";
import {
  ChatDetailSchema,
  ChatMessageSchema,
  ChatParticipantSchema,
  ChatRowSchema,
  ChatSummarySchema,
  listingDirectChatKey,
  type ChatDetail,
  type ChatMessage,
  type ChatParticipant,
  type ChatRow,
  type ChatSummary,
} from "@/db/schema/Chat";
import { toHex } from "@/utils";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The chat repository. Reads of the inbox, chat detail, membership,
 * participants, and message archive run strictly against D1 through Effect SQL.
 * Writes to `chat_messages` are deliberately absent here: the Chat Durable
 * Object is the sole writer of chat message rows so per-chat `seq` ordering
 * stays total.
 *
 * `chat_participants` is the single source of truth for membership and per-chat
 * role; inbox and chat-detail queries never self-join for a single counterpart,
 * so multi-participant chats always produce exactly one inbox row per member.
 *
 * Like the other repositories, every operation avoids interactive transactions
 * because D1 does not support `withTransaction`.
 */

export interface ChatRepository {
  readonly openOrFind: (
    listingId: typeof ListingId.Type,
    seekerId: typeof UserId.Type,
    listerId: typeof UserId.Type,
  ) => Effect.Effect<ChatRow, SqlError>;

  readonly findById: (
    chatId: typeof ChatId.Type,
  ) => Effect.Effect<Option.Option<ChatRow>, SqlError>;

  readonly findByListingAndSeeker: (
    listingId: typeof ListingId.Type,
    seekerId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<ChatRow>, SqlError>;

  readonly isParticipant: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
  ) => Effect.Effect<boolean, SqlError>;

  readonly findDetailForUser: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<ChatDetail>, SqlError>;

  readonly listInboxForUser: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<ReadonlyArray<ChatSummary>, SqlError>;

  readonly listMessagesAfter: (
    chatId: typeof ChatId.Type,
    afterSeq: number,
    limit: number,
  ) => Effect.Effect<
    { readonly messages: ReadonlyArray<ChatMessage>; readonly hasMore: boolean },
    SqlError
  >;

  readonly listRecentMessages: (
    chatId: typeof ChatId.Type,
    limit: number,
  ) => Effect.Effect<
    { readonly messages: ReadonlyArray<ChatMessage>; readonly hasMore: boolean },
    SqlError
  >;

  readonly markRead: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
    targetSeq?: number | undefined,
  ) => Effect.Effect<{ readonly lastReadSeq: number; readonly unreadCount: number }, SqlError>;
}

export const ChatRepository = Context.Service<ChatRepository>("ChatRepository");

const decodeChatRow = (row: Record<string, unknown>): ChatRow =>
  Schema.decodeUnknownSync(ChatRowSchema)(row);

const decodeChatSummary = (row: Record<string, unknown>): ChatSummary =>
  Schema.decodeUnknownSync(ChatSummarySchema)(row);

const decodeChatDetail = (row: Record<string, unknown>): ChatDetail =>
  Schema.decodeUnknownSync(ChatDetailSchema)(row);

const decodeChatMessage = (row: Record<string, unknown>): ChatMessage =>
  Schema.decodeUnknownSync(ChatMessageSchema)(row);

const decodeChatParticipant = (row: Record<string, unknown>): ChatParticipant =>
  Schema.decodeUnknownSync(ChatParticipantSchema)(row);

const generateChatId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
};

const humanizeRoleFallback = (role: string): string => {
  const normalized = role.trim();
  if (normalized === "lister") return "Listing owner";
  if (normalized === "seeker") return "Seeker";
  const words = normalized.split(/[_-\s]+/).filter((part) => part.length > 0);
  if (words.length === 0) return "Participant";
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase(),
    )
    .join(" ");
};

export const LIST_INBOX_FOR_USER_SQL = `
  SELECT
    c.id,
    c.listing_id,
    c.direct_key,
    l.title AS listing_title,
    l.region_code AS listing_region_code,
    l.price_minor AS listing_price_minor,
    cp.role AS my_role,
    cp.last_seq,
    cp.last_read_seq,
    cp.unread_count,
    c.last_message_body,
    c.last_message_sender_id,
    c.last_message_at,
    c.created_at
  FROM chat_participants cp
  JOIN chats c ON c.id = cp.chat_id
  JOIN listings l ON l.id = c.listing_id
  WHERE cp.user_id = ?
  ORDER BY cp.last_message_at DESC, cp.last_seq DESC, cp.chat_id DESC
`;

const MAX_CHAT_ID_BATCH_SIZE = 90;

export const ChatRepositoryLive = Layer.effect(
  ChatRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const loadParticipantsByChatIds = (
      chatIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ChatParticipant>>, SqlError> => {
      if (chatIds.length === 0) {
        return Effect.succeed(new Map());
      }
      const uniqueChatIds = Array.from(new Set(chatIds));
      const batches: Array<ReadonlyArray<string>> = [];
      for (let offset = 0; offset < uniqueChatIds.length; offset += MAX_CHAT_ID_BATCH_SIZE) {
        batches.push(uniqueChatIds.slice(offset, offset + MAX_CHAT_ID_BATCH_SIZE));
      }
      return Effect.forEach(batches, (batch) =>
        sql<Record<string, unknown>>`
          SELECT
            cp.chat_id,
            cp.user_id,
            cp.role,
            cp.last_read_seq,
            CASE
              WHEN cp.role = 'lister' THEN COALESCE(NULLIF(TRIM(li.name), ''), NULLIF(TRIM(sk.name), ''), '')
              WHEN cp.role = 'seeker' THEN COALESCE(NULLIF(TRIM(sk.name), ''), NULLIF(TRIM(li.name), ''), '')
              ELSE COALESCE(NULLIF(TRIM(li.name), ''), NULLIF(TRIM(sk.name), ''), '')
            END AS profile_name
          FROM chat_participants cp
          LEFT JOIN listers li ON li.user_id = cp.user_id
          LEFT JOIN seekers sk ON sk.user_id = cp.user_id
          WHERE ${sql.in("cp.chat_id", batch)}
          ORDER BY cp.chat_id ASC, cp.user_id ASC;
        `,
      ).pipe(
        Effect.map((batchRows) => {
          const grouped = new Map<string, Array<ChatParticipant>>();
          for (const rows of batchRows) {
            for (const row of rows) {
              const chatId = String(row["chatId"] ?? "");
              const role = String(row["role"] ?? "");
              const rawName =
                typeof row["profileName"] === "string" ? row["profileName"].trim() : "";
              const participant = decodeChatParticipant({
                userId: row["userId"],
                role,
                displayName: rawName.length > 0 ? rawName : humanizeRoleFallback(role),
                lastReadSeq: row["lastReadSeq"],
              });
              const list = grouped.get(chatId);
              if (list === undefined) {
                grouped.set(chatId, [participant]);
              } else {
                list.push(participant);
              }
            }
          }
          return grouped;
        }),
      );
    };

    return {
      openOrFind: (listingId, seekerId, listerId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const candidateId = generateChatId();
          const directKey = listingDirectChatKey(listingId, seekerId);

          yield* sql`
            INSERT OR IGNORE INTO chats (id, listing_id, direct_key, created_at)
            VALUES (${candidateId}, ${listingId}, ${directKey}, ${now});
          `;

          const rows = yield* sql<Record<string, unknown>>`
            SELECT *
              FROM chats
             WHERE direct_key = ${directKey}
             LIMIT 1;
          `;
          const chat = decodeChatRow(Option.getOrThrow(Option.fromNullishOr(rows[0])));
          const createdMs = chat.createdAt.getTime();

          yield* sql`
            INSERT OR IGNORE INTO chat_participants (
              chat_id, user_id, role, last_read_seq, last_seq, unread_count, last_message_at
            )
            VALUES
              (${chat.id}, ${seekerId}, 'seeker', 0, 0, 0, ${createdMs}),
              (${chat.id}, ${listerId}, 'lister', 0, 0, 0, ${createdMs});
          `;

          return chat;
        }),

      findById: (chatId) =>
        sql<Record<string, unknown>>`
          SELECT *
            FROM chats
           WHERE id = ${chatId}
           LIMIT 1;
        `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeChatRow)),
        ),

      findByListingAndSeeker: (listingId, seekerId) => {
        const directKey = listingDirectChatKey(listingId, seekerId);
        return sql<Record<string, unknown>>`
          SELECT *
            FROM chats
           WHERE direct_key = ${directKey}
           LIMIT 1;
        `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeChatRow)),
        );
      },

      isParticipant: (chatId, userId) =>
        sql<{ readonly found: number }>`
          SELECT 1 AS found
            FROM chat_participants
           WHERE chat_id = ${chatId}
             AND user_id = ${userId}
           LIMIT 1;
        `.pipe(Effect.map((rows) => rows.length > 0)),

      findDetailForUser: (chatId, userId) =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              c.id,
              c.listing_id,
              c.direct_key,
              l.title AS listing_title,
              l.region_code AS listing_region_code,
              l.price_minor AS listing_price_minor,
              cp.role AS my_role,
              cp.last_seq,
              cp.last_read_seq,
              cp.unread_count,
              c.last_message_body,
              c.last_message_sender_id,
              c.last_message_at,
              c.created_at
            FROM chat_participants cp
            JOIN chats c ON c.id = cp.chat_id
            JOIN listings l ON l.id = c.listing_id
            WHERE cp.chat_id = ${chatId}
              AND cp.user_id = ${userId}
            LIMIT 1;
          `;
          const row = rows[0];
          if (row === undefined) {
            return Option.none();
          }
          const byChat = yield* loadParticipantsByChatIds([String(row["id"] ?? chatId)]);
          const participants = byChat.get(String(row["id"] ?? chatId)) ?? [];
          return Option.some(decodeChatDetail({ ...row, participants }));
        }),

      listInboxForUser: (userId) =>
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<Record<string, unknown>>(LIST_INBOX_FOR_USER_SQL, [
            userId,
          ]);
          if (rows.length === 0) {
            return [];
          }
          const chatIds = rows.map((row) => String(row["id"] ?? ""));
          const byChat = yield* loadParticipantsByChatIds(chatIds);
          return rows.map((row) => {
            const id = String(row["id"] ?? "");
            return decodeChatSummary({
              ...row,
              participants: byChat.get(id) ?? [],
            });
          });
        }),

      listMessagesAfter: (chatId, afterSeq, limit) =>
        sql<Record<string, unknown>>`
          SELECT id, chat_id, seq, sender_id, client_message_id, body, created_at
            FROM chat_messages
           WHERE chat_id = ${chatId}
             AND seq > ${afterSeq}
          ORDER BY seq ASC
           LIMIT ${limit + 1};
        `.pipe(
          Effect.map((rows) => {
            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;
            return { messages: page.map(decodeChatMessage), hasMore };
          }),
        ),

      listRecentMessages: (chatId, limit) =>
        sql<Record<string, unknown>>`
          SELECT id, chat_id, seq, sender_id, client_message_id, body, created_at
            FROM chat_messages
           WHERE chat_id = ${chatId}
          ORDER BY seq DESC
           LIMIT ${limit + 1};
        `.pipe(
          Effect.map((rows) => {
            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;
            return { messages: page.map(decodeChatMessage).reverse(), hasMore };
          }),
        ),

      markRead: (chatId, userId, targetSeq) =>
        Effect.gen(function* () {
          const seqParam = targetSeq ?? null;
          const rows = yield* sql<{ readonly lastReadSeq: number; readonly unreadCount: number }>`
            UPDATE chat_participants
               SET last_read_seq = MAX(last_read_seq, MIN(COALESCE(${seqParam}, last_seq), last_seq)),
                   unread_count = (
                     SELECT COUNT(*)
                       FROM chat_messages
                      WHERE chat_id = chat_participants.chat_id
                        AND seq > MAX(
                              chat_participants.last_read_seq,
                              MIN(COALESCE(${seqParam}, chat_participants.last_seq), chat_participants.last_seq)
                            )
                        AND sender_id <> chat_participants.user_id
                   )
             WHERE chat_id = ${chatId}
               AND user_id = ${userId}
            RETURNING last_read_seq, unread_count;
          `;
          const row = rows[0];
          if (row === undefined) {
            return { lastReadSeq: 0, unreadCount: 0 };
          }
          return {
            lastReadSeq: Number(row.lastReadSeq),
            unreadCount: Number(row.unreadCount),
          };
        }),
    } satisfies ChatRepository;
  }).pipe(Effect.tapError((error) => Effect.logError("Chat repository failed", { error }))),
);
