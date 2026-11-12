import { ChatId, ListingId, UserId } from "@/db/schema/brands";
import {
  CHAT_INBOX_LIMIT,
  CHAT_INBOX_PREVIEW_LENGTH,
  CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
  ChatMessageBody,
  ChatMessageSchema,
  type ChatDetail,
  type ChatInbox,
  type ChatMessage,
  type ChatMessages,
  type ChatRead,
  type SendMessageInput,
} from "@/db/schema/Chat";
import type { ChatMessageRow } from "@/durable-objects/chat-core";
import { ChatObject } from "@/repos/chat-object.repo";
import { ChatRepository } from "@/repos/chat.repo";
import { ChatTicketService } from "@/services/chat-ticket.service";
import { ListingService, type ListingNotFoundError } from "@/services/listing.service";
import { InternalError } from "@/services/user.service";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The chat service owns every rule that spans more than one row: who may see a
 * thread, what opening a thread means for that person's read mark, and how a
 * listing's owner and the person who asked about it become the two participants.
 *
 * It never writes a message itself. A send is addressed to the chat object, which
 * allocates the sequence number and archives the row, so the ordering rule has
 * exactly one owner whether the message came over a socket or through the
 * no-socket POST path.
 */

export class ChatNotFoundError extends Schema.TaggedError<ChatNotFoundError>()(
  "ChatNotFoundError",
  { id: ChatId },
  { httpApiStatus: 404 },
) {}

export class ChatValidationError extends Schema.TaggedError<ChatValidationError>()(
  "ChatValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class ChatRateLimitedError extends Schema.TaggedError<ChatRateLimitedError>()(
  "ChatRateLimitedError",
  {},
  { httpApiStatus: 429 },
) {}

export interface ChatService {
  /*
   * The caller's threads, newest activity first, each with an unread count. One
   * query against D1: the inbox never reads the chat object.
   */
  readonly listInbox: (userId: typeof UserId.Type) => Effect.Effect<ChatInbox, InternalError>;

  /*
   * One thread, and the act of reading it: the caller's read mark moves to the
   * newest sequence number the chat has, which is what clears the inbox badge.
   * Opening a thread is a read in this model, on the page and on the API alike.
   */
  readonly openChat: (
    userId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
  ) => Effect.Effect<ChatDetail, ChatNotFoundError | InternalError>;

  readonly listMessages: (
    userId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
    page: { readonly after: number; readonly limit: number },
  ) => Effect.Effect<ChatMessages, ChatNotFoundError | InternalError>;

  /*
   * A reader's acknowledgement that the open thread has shown messages up to
   * `seq`. It is clamped to the chat's own last sequence number, so a receipt
   * cannot mark future messages as already read.
   */
  readonly markRead: (
    userId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
    seq: number,
  ) => Effect.Effect<ChatRead, ChatNotFoundError | InternalError>;

  /*
   * The no-socket fallback. It goes through the chat object exactly as a socket
   * send does, so it gets the same sequence number, the same archive row, and the
   * same fan-out to anyone who does have a socket open.
   */
  readonly sendMessage: (
    userId: typeof UserId.Type,
    chatId: typeof ChatId.Type,
    input: SendMessageInput,
  ) => Effect.Effect<
    ChatMessage,
    ChatNotFoundError | ChatValidationError | ChatRateLimitedError | InternalError
  >;

  /*
   * The listing's contact control. The thread is keyed on the listing and the
   * person who asked, so pressing it twice reopens the same thread, and the first
   * message is the contact itself rather than a parallel enquiry surface.
   */
  readonly startChat: (
    userId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
    input: SendMessageInput,
  ) => Effect.Effect<
    { readonly chatId: typeof ChatId.Type; readonly message: ChatMessage },
    ListingNotFoundError | ChatValidationError | ChatRateLimitedError | InternalError
  >;
}

export const ChatService = Context.Service<ChatService>("ChatService");

// Services collapse driver failures into `InternalError` (the 500 contract every
// other service already follows) and log the real cause.
const fromSql = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, InternalError> =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.logError("Chat operation failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        ),
    }),
  );

// A body that does not satisfy the shared codec is a bad request, never a driver
// failure: a whitespace-only message must not reach the table's CHECK constraint.
const decodeBody = (body: string): Effect.Effect<string, ChatValidationError> =>
  Schema.decodeUnknownEffect(ChatMessageBody)(body).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new ChatValidationError({ message: String(error) })),
    ),
  );

// The object's own archive row is already the model's shape, so decoding it is
// what turns the stored millisecond timestamp into a `Date` and brands the ids.
const toMessage = (row: ChatMessageRow): ChatMessage =>
  Schema.decodeUnknownSync(ChatMessageSchema)({ ...row });

// An inbox shows one line of the newest message, not the message.
const preview = (body: string | null | undefined): string | null => {
  if (body == null) return null;
  const flattened = body.replace(/\s+/g, " ").trim();
  return flattened.length <= CHAT_INBOX_PREVIEW_LENGTH
    ? flattened
    : `${flattened.slice(0, CHAT_INBOX_PREVIEW_LENGTH - 1).trimEnd()}…`;
};

export const ChatServiceLive = Layer.effect(
  ChatService,
  Effect.gen(function* () {
    const repo = yield* ChatRepository;
    const listings = yield* ListingService;
    const chatObject = yield* ChatObject;
    const tickets = yield* ChatTicketService;

    /*
     * A chat is loaded through the caller's own participant row, so an unknown
     * chat and another account's chat are the same 404. That is deliberate: the
     * id alone must never tell a caller that a thread exists.
     */
    const load = (userId: typeof UserId.Type, chatId: typeof ChatId.Type) =>
      Effect.gen(function* () {
        const found = yield* fromSql(repo.findForUser(chatId, userId));
        return yield* Option.match(found, {
          onNone: () => Effect.fail(new ChatNotFoundError({ id: chatId })),
          onSome: Effect.succeed,
        });
      });

    const deliver = (
      userId: typeof UserId.Type,
      chatId: typeof ChatId.Type,
      input: SendMessageInput,
    ) =>
      Effect.gen(function* () {
        const body = yield* decodeBody(input.body);
        // A caller that names no id still gets a unique one, so two identical
        // messages are two rows while a retry of one send is not.
        const clientMessageId = input.clientMessageId ?? crypto.randomUUID();
        const ticket = yield* tickets.sign({ userId, chatId });
        const outcome = yield* chatObject.append({ chatId, ticket, clientMessageId, body });

        switch (outcome._tag) {
          case "stored":
            return toMessage(outcome.message);
          case "rate_limited":
            return yield* Effect.fail(new ChatRateLimitedError());
          case "invalid":
            return yield* Effect.fail(new ChatValidationError({ message: outcome.message }));
        }
      }).pipe(
        Effect.catchTags({
          ChatTicketSigningError: (error) =>
            Effect.logError("A chat ticket could not be signed", { error }).pipe(
              Effect.andThen(Effect.fail(new InternalError())),
            ),
          ChatObjectError: (error) =>
            Effect.logError("The chat object could not be reached", { error }).pipe(
              Effect.andThen(Effect.fail(new InternalError())),
            ),
        }),
      );

    return {
      listInbox: (userId) =>
        Effect.gen(function* () {
          const rows = yield* fromSql(repo.listInbox(userId, CHAT_INBOX_LIMIT));
          return {
            items: rows.map((row) => ({
              ...row,
              lastMessagePreview: preview(row.lastMessagePreview),
            })),
          } satisfies ChatInbox;
        }),

      openChat: (userId, chatId) =>
        Effect.gen(function* () {
          const access = yield* load(userId, chatId);
          const participants = yield* fromSql(repo.listParticipants(chatId));
          if (access.lastSeq > access.lastReadSeq) {
            yield* fromSql(repo.markRead(chatId, userId, access.lastSeq));
          }
          return {
            id: access.id,
            listingId: access.listingId,
            listingTitle: access.listingTitle,
            createdAt: access.createdAt,
            lastSeq: access.lastSeq,
            lastReadSeq: Math.max(access.lastReadSeq, access.lastSeq),
            participants,
          } satisfies ChatDetail;
        }),

      listMessages: (userId, chatId, page) =>
        Effect.gen(function* () {
          const access = yield* load(userId, chatId);
          const items = yield* fromSql(
            repo.listMessages(
              chatId,
              page.after,
              page.limit > 0 ? page.limit : CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
            ),
          );
          return { items, lastSeq: access.lastSeq } satisfies ChatMessages;
        }),

      markRead: (userId, chatId, seq) =>
        Effect.gen(function* () {
          const access = yield* load(userId, chatId);
          const next = Math.min(seq, access.lastSeq);
          if (next > access.lastReadSeq) {
            yield* fromSql(repo.markRead(chatId, userId, next));
          }
          return { lastReadSeq: Math.max(access.lastReadSeq, next) } satisfies ChatRead;
        }),

      sendMessage: (userId, chatId, input) =>
        Effect.gen(function* () {
          yield* load(userId, chatId);
          return yield* deliver(userId, chatId, input);
        }),

      startChat: (userId, listingId, input) =>
        Effect.gen(function* () {
          // The visibility rule stays in the listing service: a draft or unlisted
          // listening is the same 404 here as everywhere else.
          const listing = yield* listings.getPublic(listingId);
          if (listing.ownerId === userId) {
            return yield* Effect.fail(
              new ChatValidationError({
                message: "You cannot start a chat about your own listing.",
              }),
            );
          }

          const chat = yield* fromSql(
            repo.findOrCreate({
              listingId,
              seekerUserId: userId,
              listerUserId: listing.ownerId,
            }),
          );
          const message = yield* deliver(userId, chat.id, input);
          return { chatId: chat.id, message };
        }),
    } satisfies ChatService;
  }).pipe(Effect.tapError((error) => Effect.logError("Chat service failed", { error }))),
);
