import { ChatId, ListingId, UserId } from "@/db/schema/brands";
import {
  CHAT_MESSAGES_DEFAULT_LIMIT,
  CHAT_MESSAGES_MAX_LIMIT,
  type ChatDetail,
  type ChatInboxResponse,
  type ChatMessage,
  type ChatMessagesResponse,
  type MarkChatReadResponse,
} from "@/db/schema/Chat";
import { ChatRepository } from "@/repos/chat.repo";
import { ListingRepository } from "@/repos/listing.repo";
import {
  ChatConflictError,
  ChatForbiddenError,
  ChatNotFoundError,
  ChatRateLimitError,
  ChatSelfNotAllowedError,
  ChatValidationError,
} from "@/services/chat-errors";
import { ChatGateway } from "@/services/chat-gateway.service";
import { ListingNotFoundError } from "@/services/listing.service";
import { InternalError } from "@/services/user.service";
import { toHex } from "@/utils";
import { Context, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/sql/SqlError";

export {
  ChatConflictError,
  ChatForbiddenError,
  ChatNotFoundError,
  ChatRateLimitError,
  ChatSelfNotAllowedError,
  ChatValidationError,
};

/*
 * The chat service. It owns chat creation rules (published listing only, no
 * self-chats, one chat per (listing, seeker) pair), membership authorization
 * for reads/writes, inbox aggregation from D1, and forwarding message writes
 * through `ChatGateway` so the Chat Durable Object remains the sole writer of
 * `chat_messages`.
 */

export interface ChatService {
  readonly openForListing: (
    callerId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
  ) => Effect.Effect<ChatDetail, ListingNotFoundError | ChatSelfNotAllowedError | InternalError>;

  readonly findForListingAndCaller: (
    callerId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
  ) => Effect.Effect<Option.Option<typeof ChatId.Type>, InternalError>;

  readonly listInbox: (
    callerId: typeof UserId.Type,
  ) => Effect.Effect<ChatInboxResponse, InternalError>;

  readonly getChat: (
    callerId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
  ) => Effect.Effect<ChatDetail, ChatNotFoundError | ChatForbiddenError | InternalError>;

  readonly listMessages: (
    callerId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
    options?: { readonly after?: number | undefined; readonly limit?: number | undefined },
  ) => Effect.Effect<ChatMessagesResponse, ChatNotFoundError | ChatForbiddenError | InternalError>;

  readonly listRecentMessages: (
    callerId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
    limit?: number | undefined,
  ) => Effect.Effect<ChatMessagesResponse, ChatNotFoundError | ChatForbiddenError | InternalError>;

  readonly sendMessage: (
    callerId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
    input: { readonly body: string; readonly clientMessageId?: string | undefined },
  ) => Effect.Effect<
    ChatMessage,
    | ChatNotFoundError
    | ChatForbiddenError
    | ChatValidationError
    | ChatConflictError
    | ChatRateLimitError
    | InternalError
  >;

  readonly markRead: (
    callerId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
    seq?: number | undefined,
  ) => Effect.Effect<MarkChatReadResponse, ChatNotFoundError | ChatForbiddenError | InternalError>;
}

export const ChatService = Context.Service<ChatService>("ChatService");

const fromSql = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, InternalError> =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.logError("Chat operation failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        ),
    }),
  );

const generateClientMessageId = (): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `srv-${toHex(bytes)}`;
};

export const ChatServiceLive = Layer.effect(
  ChatService,
  Effect.gen(function* () {
    const chatRepo = yield* ChatRepository;
    const listingRepo = yield* ListingRepository;
    const chatGateway = yield* ChatGateway;

    const assertParticipant = (
      callerId: typeof UserId.Type,
      chatId: typeof ChatId.Type,
    ): Effect.Effect<void, ChatNotFoundError | ChatForbiddenError | InternalError> =>
      Effect.gen(function* () {
        const found = yield* fromSql(chatRepo.findById(chatId));
        if (Option.isNone(found)) {
          return yield* Effect.fail(new ChatNotFoundError({ id: chatId }));
        }
        const member = yield* fromSql(chatRepo.isParticipant(chatId, callerId));
        if (!member) {
          return yield* Effect.fail(new ChatForbiddenError({ id: chatId }));
        }
      });

    return {
      openForListing: (callerId, listingId) =>
        Effect.gen(function* () {
          const listing = yield* fromSql(listingRepo.findById(listingId));
          if (Option.isNone(listing) || listing.value.status !== "published") {
            return yield* Effect.fail(new ListingNotFoundError({ id: listingId }));
          }
          if (listing.value.ownerId === callerId) {
            return yield* Effect.fail(new ChatSelfNotAllowedError({ listingId }));
          }

          const chat = yield* fromSql(
            chatRepo.openOrFind(listing.value.id, callerId, listing.value.ownerId),
          );
          const detail = yield* fromSql(chatRepo.findDetailForUser(chat.id, callerId));
          if (Option.isNone(detail)) {
            return yield* Effect.fail(new InternalError());
          }
          return detail.value;
        }),

      findForListingAndCaller: (callerId, listingId) =>
        fromSql(chatRepo.findByListingAndSeeker(listingId, callerId)).pipe(
          Effect.map(Option.map((chat) => chat.id)),
        ),

      listInbox: (callerId) =>
        fromSql(chatRepo.listInboxForUser(callerId)).pipe(
          Effect.map((items) => ({
            items,
            totalUnread: items.reduce((sum, item) => sum + item.unreadCount, 0),
          })),
        ),

      getChat: (callerId, chatId) =>
        Effect.gen(function* () {
          yield* assertParticipant(callerId, chatId);
          const detail = yield* fromSql(chatRepo.findDetailForUser(chatId, callerId));
          if (Option.isNone(detail)) {
            return yield* Effect.fail(new ChatNotFoundError({ id: chatId }));
          }
          return detail.value;
        }),

      listMessages: (callerId, chatId, options = {}) =>
        Effect.gen(function* () {
          yield* assertParticipant(callerId, chatId);
          const after = Math.max(0, Math.floor(options.after ?? 0));
          const limit = Math.min(
            CHAT_MESSAGES_MAX_LIMIT,
            Math.max(1, Math.floor(options.limit ?? CHAT_MESSAGES_DEFAULT_LIMIT)),
          );
          return yield* fromSql(chatRepo.listMessagesAfter(chatId, after, limit));
        }),

      listRecentMessages: (callerId, chatId, limit) =>
        Effect.gen(function* () {
          yield* assertParticipant(callerId, chatId);
          const clampedLimit = Math.min(
            CHAT_MESSAGES_MAX_LIMIT,
            Math.max(1, Math.floor(limit ?? CHAT_MESSAGES_DEFAULT_LIMIT)),
          );
          return yield* fromSql(chatRepo.listRecentMessages(chatId, clampedLimit));
        }),

      sendMessage: (callerId, chatId, input) =>
        Effect.gen(function* () {
          yield* assertParticipant(callerId, chatId);
          const clientMessageId = input.clientMessageId ?? generateClientMessageId();
          return yield* chatGateway.postMessage(chatId, callerId, {
            body: input.body,
            clientMessageId,
          });
        }),

      markRead: (callerId, chatId, seq) =>
        Effect.gen(function* () {
          yield* assertParticipant(callerId, chatId);
          const result = yield* fromSql(chatRepo.markRead(chatId, callerId, seq));
          yield* chatGateway.notifyRead(chatId, callerId, result.lastReadSeq);
          return {
            chatId,
            lastReadSeq: result.lastReadSeq,
            unreadCount: result.unreadCount,
          };
        }),
    } satisfies ChatService;
  }),
);
