import { ChatId, ChatMessageId, ListingId, UserId } from "@/db/schema/brands";
import { NonBlankFiniteFromString } from "@/db/schema/codecs";
import { Effect, Schema, SchemaTransformation } from "effect";

/*
 * A chat is the thread between a listing's owner and the one person who asked
 * about it. It starts from the listing's contact control, so the first message
 * is the contact itself and there is no second contact surface beside it.
 *
 * The model here is the D1 shape: the thread row, its two participants, and the
 * archived messages. Sequence numbers are allocated by the chat object and are
 * the display order; `created_at` is wall-clock data that two rows may share.
 */

export const CHAT_MESSAGE_MAX_LENGTH = 4000;
export const CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH = 120;

// The inbox is a list, not a feed: one row per thread this account is in, and a
// person does not have more open threads than this in the MVP.
export const CHAT_INBOX_LIMIT = 100;

export const CHAT_MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const CHAT_MESSAGE_PAGE_MAX_LIMIT = 100;

// A preview is one line in the inbox, not the message body it came from.
export const CHAT_INBOX_PREVIEW_LENGTH = 120;

/*
 * A path segment is not a chat id until it is a positive safe integer, so "abc"
 * or "1.5" reads as "no such chat" instead of reaching the database.
 */
export const decodeChatId = (raw: string | undefined): typeof ChatId.Type | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return Schema.decodeSync(ChatId)(id);
};

// A message is trimmed before it is bounded, so a padded message is stored
// trimmed and a whitespace-only one is rejected instead of reaching the table's
// CHECK constraint.
export const ChatMessageBody = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(CHAT_MESSAGE_MAX_LENGTH)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);

/*
 * The client's own id for a send, which is what makes a retry land on the row it
 * already wrote instead of a second one. It is opaque to the server: the only
 * rule is that it is present and short enough to store.
 */
export const ChatClientMessageId = Schema.NonEmptyString.check(
  Schema.isMaxLength(CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH),
);

export const ChatSchema = Schema.Struct({
  id: ChatId,
  listingId: ListingId,
  seekerUserId: UserId,
  listerUserId: UserId,
  lastSeq: Schema.Int,
  lastMessageAt: Schema.NullishOr(Schema.DateFromMillis),
  createdAt: Schema.DateFromMillis,
});
export type Chat = typeof ChatSchema.Type;

export const ChatMessageSchema = Schema.Struct({
  id: ChatMessageId,
  chatId: ChatId,
  seq: Schema.Int,
  senderId: UserId,
  body: Schema.String,
  clientMessageId: Schema.String,
  createdAt: Schema.DateFromMillis,
});
export type ChatMessage = typeof ChatMessageSchema.Type;

/*
 * One side of a thread as the page shows it: the account, the name its profile
 * carries when it has one, and how far it has read. The name is resolved in SQL
 * because a person may hold either profile kind.
 */
export const ChatParticipantSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  lastReadSeq: Schema.Int,
});
export type ChatParticipant = typeof ChatParticipantSchema.Type;

/*
 * One inbox row. `unreadCount` counts the other side's messages above this
 * person's read mark, so a message this person sent is never unread to them, and
 * `lastMessagePreview` is the newest body cut to one line. Both come from D1: the
 * inbox never asks the chat object anything.
 */
export const ChatInboxItemSchema = Schema.Struct({
  id: ChatId,
  listingId: ListingId,
  listingTitle: Schema.String,
  counterpartUserId: UserId,
  counterpartName: Schema.String,
  lastSeq: Schema.Int,
  lastMessageAt: Schema.NullishOr(Schema.DateFromMillis),
  lastMessagePreview: Schema.NullishOr(Schema.String),
  unreadCount: Schema.Int,
  // The thread's own start, which is what the row shows when nothing has been
  // said in it yet.
  createdAt: Schema.DateFromMillis,
});
export type ChatInboxItem = typeof ChatInboxItemSchema.Type;

export const ChatInboxSchema = Schema.Struct({
  items: Schema.Array(ChatInboxItemSchema),
});
export type ChatInbox = typeof ChatInboxSchema.Type;

export const ChatDetailSchema = Schema.Struct({
  id: ChatId,
  listingId: ListingId,
  listingTitle: Schema.String,
  createdAt: Schema.DateFromMillis,
  lastSeq: Schema.Int,
  lastReadSeq: Schema.Int,
  participants: Schema.Array(ChatParticipantSchema),
});
export type ChatDetail = typeof ChatDetailSchema.Type;

export const ChatMessagesSchema = Schema.Struct({
  items: Schema.Array(ChatMessageSchema),
  // The chat's highest allocated sequence number, so a client knows whether it
  // has caught up without asking a second question.
  lastSeq: Schema.Int,
  // Whether messages older than this page's first item exist, so the thread can
  // stop offering an earlier page at the first message.
  hasEarlier: Schema.Boolean,
});
export type ChatMessages = typeof ChatMessagesSchema.Type;

/*
 * What a caller sends: the message, and optionally their own id for it. The
 * socket protocol requires the id, because a reconnecting client retries; the
 * no-socket POST path fills one in when it is absent.
 */
export const SendMessageInput = Schema.Struct({
  body: ChatMessageBody,
  clientMessageId: Schema.optional(ChatClientMessageId),
});
export type SendMessageInput = typeof SendMessageInput.Type;

/*
 * The reader's acknowledgement: the highest sequence number the open thread has
 * shown. The server clamps it to the chat's own last sequence number, so a
 * receipt can never mark messages that do not exist yet as read.
 */
export const ChatReadInput = Schema.Struct({
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ChatReadInput = typeof ChatReadInput.Type;

export const ChatReadSchema = Schema.Struct({
  lastReadSeq: Schema.Int,
});
export type ChatRead = typeof ChatReadSchema.Type;

/*
 * A cursor over the archive: `after` is the highest sequence number the caller
 * already has, so a reconnect asks for what it missed; `before` is the oldest
 * sequence number it already has, so the thread can ask for the page immediately
 * older. The two are different questions and cannot be combined. Query
 * parameters arrive as strings, so every field carries a string codec, and a
 * blank or non-integer one is a bad request instead of seq 0.
 */
const ChatSeqFromString = NonBlankFiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const ChatMessageLimitFromString = NonBlankFiniteFromString.pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CHAT_MESSAGE_PAGE_MAX_LIMIT })),
    SchemaTransformation.passthrough(),
  ),
);

const validateMessageCursor = (query: {
  readonly after?: number | undefined;
  readonly before?: number | undefined;
}): ReadonlyArray<Schema.FilterIssue> =>
  query.after !== undefined && query.before !== undefined
    ? [{ path: ["before"], issue: "after and before cannot both be set" }]
    : [];

export const ChatMessagesQuery = Schema.Struct({
  after: Schema.optional(ChatSeqFromString),
  before: Schema.optional(ChatSeqFromString),
  limit: ChatMessageLimitFromString.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(CHAT_MESSAGE_PAGE_DEFAULT_LIMIT)),
  ),
}).check(Schema.makeFilter(validateMessageCursor));
export type ChatMessagesQuery = typeof ChatMessagesQuery.Type;
