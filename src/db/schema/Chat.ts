import { ChatId, ChatMessageId, ListingId, UserId } from "@/db/schema/brands";
import { NonBlankFiniteFromString } from "@/db/schema/codecs";
import { GreekRegion } from "@/db/schema/Listing";
import { Effect, Schema, SchemaTransformation } from "effect";

/*
 * Schemas for the chat domain.
 *
 * Display order inside a chat is strictly `seq`, never `createdAt`. Membership
 * and per-chat roles live in `chat_participants` as an open-ended participant
 * list (`participants[]`), while direct 1-to-1 listing enquiries deduplicate
 * via `chats.direct_key`. Bodies and clientMessageIds are trimmed before length
 * checks so whitespace-only payloads are refused at the boundary rather than
 * reaching the Durable Object or D1.
 */

export const CHAT_MESSAGE_MAX_LENGTH = 2000;
export const CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH = 128;
export const CHAT_ROLE_MAX_LENGTH = 64;
export const CHAT_MESSAGES_DEFAULT_LIMIT = 50;
export const CHAT_MESSAGES_MAX_LIMIT = 100;

export const ChatParticipantRole = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(CHAT_ROLE_MAX_LENGTH)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);
export type ChatParticipantRole = typeof ChatParticipantRole.Type;

// Deterministic key for deduplicating direct 1-to-1 listing enquiries while
// leaving `direct_key` NULL for multi-participant chats.
export const listingDirectChatKey = (
  listingId: typeof ListingId.Type,
  seekerId: typeof UserId.Type,
): string => `listing:${listingId}:seeker:${seekerId}`;

// A path segment is not a chat id until it matches the server-generated format
// (hex/UUID/url-safe token), so arbitrary strings fail cleanly before SQL or DO.
const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export const decodeChatId = (raw: string | undefined): typeof ChatId.Type | undefined => {
  if (raw === undefined || !CHAT_ID_PATTERN.test(raw)) return undefined;
  return Schema.decodeSync(ChatId)(raw);
};

export const ChatMessageBody = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(CHAT_MESSAGE_MAX_LENGTH)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);

export const ClientMessageId = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);

export const ChatRowSchema = Schema.Struct({
  id: ChatId,
  listingId: ListingId,
  directKey: Schema.NullishOr(Schema.String),
  lastSeq: Schema.Int,
  lastMessageBody: Schema.NullishOr(Schema.String),
  lastMessageSenderId: Schema.NullishOr(UserId),
  lastMessageAt: Schema.NullishOr(Schema.DateFromMillis),
  createdAt: Schema.DateFromMillis,
});
export type ChatRow = typeof ChatRowSchema.Type;

export const ChatMessageSchema = Schema.Struct({
  id: ChatMessageId,
  chatId: ChatId,
  seq: Schema.Int,
  senderId: UserId,
  clientMessageId: Schema.String,
  body: Schema.String,
  createdAt: Schema.DateFromMillis,
});
export type ChatMessage = typeof ChatMessageSchema.Type;

export const ChatParticipantSchema = Schema.Struct({
  userId: UserId,
  role: Schema.String,
  displayName: Schema.String,
  lastReadSeq: Schema.Int,
});
export type ChatParticipant = typeof ChatParticipantSchema.Type;

export const ChatSummarySchema = Schema.Struct({
  id: ChatId,
  listingId: ListingId,
  directKey: Schema.NullishOr(Schema.String),
  listingTitle: Schema.String,
  listingRegionCode: GreekRegion,
  listingPriceMinor: Schema.Int,
  myRole: Schema.String,
  participants: Schema.Array(ChatParticipantSchema),
  lastSeq: Schema.Int,
  lastReadSeq: Schema.Int,
  unreadCount: Schema.Int,
  lastMessageBody: Schema.NullishOr(Schema.String),
  lastMessageSenderId: Schema.NullishOr(UserId),
  lastMessageAt: Schema.NullishOr(Schema.DateFromMillis),
  createdAt: Schema.DateFromMillis,
});
export type ChatSummary = typeof ChatSummarySchema.Type;

export const ChatDetailSchema = ChatSummarySchema;
export type ChatDetail = typeof ChatDetailSchema.Type;

export const ChatInboxResponse = Schema.Struct({
  items: Schema.Array(ChatSummarySchema),
  totalUnread: Schema.Int,
});
export type ChatInboxResponse = typeof ChatInboxResponse.Type;

export const ChatMessagesResponse = Schema.Struct({
  messages: Schema.Array(ChatMessageSchema),
  hasMore: Schema.Boolean,
});
export type ChatMessagesResponse = typeof ChatMessagesResponse.Type;

export const OpenChatInput = Schema.Struct({
  listingId: ListingId,
});
export type OpenChatInput = typeof OpenChatInput.Type;

export const PostChatMessageInput = Schema.Struct({
  body: ChatMessageBody,
  clientMessageId: Schema.optional(ClientMessageId),
});
export type PostChatMessageInput = typeof PostChatMessageInput.Type;

export const MarkChatReadInput = Schema.Struct({
  seq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type MarkChatReadInput = typeof MarkChatReadInput.Type;

export const MarkChatReadResponse = Schema.Struct({
  chatId: ChatId,
  lastReadSeq: Schema.Int,
  unreadCount: Schema.Int,
});
export type MarkChatReadResponse = typeof MarkChatReadResponse.Type;

const NonNegativeIntFromString = NonBlankFiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const ChatMessagesLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: CHAT_MESSAGES_MAX_LIMIT }),
);

const ChatMessagesLimitFromString = NonBlankFiniteFromString.pipe(
  Schema.decodeTo(ChatMessagesLimit, SchemaTransformation.passthrough()),
);

export const ChatMessagesQuery = Schema.Struct({
  after: NonNegativeIntFromString.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(0))),
  limit: ChatMessagesLimitFromString.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(CHAT_MESSAGES_DEFAULT_LIMIT)),
  ),
});
export type ChatMessagesQuery = typeof ChatMessagesQuery.Type;
