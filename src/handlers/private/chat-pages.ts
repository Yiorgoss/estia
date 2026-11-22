import { decodeChatId } from "@/db/schema/Chat";
import { decodeListingId } from "@/db/schema/Listing";
import { chatDetailPage, chatErrorPage, chatsInboxPage } from "@/frontend/pages/chats";
import { callerUser } from "@/handlers/private/caller";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import { ChatService } from "@/services/chat.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";
import { Effect, Result } from "effect";

/*
 * Server-rendered chat pages and form actions. Every route lives on the
 * private router behind `AuthMiddleware`, so signed-out visitors receive the
 * HTML sign-in prompt rather than a bare 401 string, and every state-changing
 * form post passes the shared same-origin write check.
 */

const html = (body: string, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

const seeOther = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location, { status: 303 });

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

const chatsInboxRoute = HttpRouter.route("GET", "/chats", () =>
  Effect.gen(function* () {
    const user = yield* callerUser;
    const chatService = yield* ChatService;
    const inbox = yield* chatService.listInbox(user.id);
    return html(chatsInboxPage({ ...inbox, currentUserId: user.id }));
  }).pipe(
    Effect.catchTags({
      UnauthorizedError: () =>
        Effect.succeed(
          html(chatErrorPage("Sign in required", "Please sign in to view your chats."), 401),
        ),
      InternalError: () =>
        Effect.succeed(
          html(chatErrorPage("Chats unavailable", "Your chats could not be loaded just now."), 500),
        ),
    }),
  ),
);

const chatDetailRoute = HttpRouter.route("GET", "/chats/:id", () =>
  Effect.gen(function* () {
    const user = yield* callerUser;
    const chatId = yield* Effect.map(HttpRouter.params, (params) => decodeChatId(params["id"]));
    if (chatId === undefined) {
      return html(chatErrorPage("Chat not found", "This chat does not exist."), 404);
    }

    const chatService = yield* ChatService;
    const chat = yield* chatService.getChat(user.id, chatId);
    const { messages } = yield* chatService.listRecentMessages(user.id, chatId, 100);
    const lastRenderedSeq = messages[messages.length - 1]?.seq ?? 0;

    // Opening a chat clears the caller's unread count and notifies the Chat DO
    // so the other participant's live thread updates.
    const read = yield* chatService.markRead(user.id, chatId, lastRenderedSeq);

    return html(
      chatDetailPage({
        chat: {
          ...chat,
          lastReadSeq: read.lastReadSeq,
          unreadCount: read.unreadCount,
          participants: chat.participants.map((participant) =>
            participant.userId === user.id
              ? { ...participant, lastReadSeq: read.lastReadSeq }
              : participant,
          ),
        },
        messages,
        currentUserId: user.id,
      }),
    );
  }).pipe(
    Effect.catchTags({
      UnauthorizedError: () =>
        Effect.succeed(
          html(chatErrorPage("Sign in required", "Please sign in to view this chat."), 401),
        ),
      ChatNotFoundError: () =>
        Effect.succeed(html(chatErrorPage("Chat not found", "This chat does not exist."), 404)),
      ChatForbiddenError: () =>
        Effect.succeed(
          html(chatErrorPage("Access denied", "You are not a participant in this chat."), 403),
        ),
      InternalError: () =>
        Effect.succeed(
          html(chatErrorPage("Chat unavailable", "This chat could not be loaded just now."), 500),
        ),
    }),
  ),
);

// Progressive-enhancement / no-socket fallback for sending a chat message from
// the page form. Routes through `ChatService.sendMessage` -> `Chat` DO so
// ordering, rate limiting, and live fan-out match the WebSocket path.
const postChatMessageRoute = HttpRouter.route("POST", "/chats/:id/messages", (request) =>
  Effect.gen(function* () {
    const user = yield* callerUser;
    if (!isSameOriginWrite(request)) {
      return html(chatErrorPage("Action refused", crossSiteFormMessage), 403);
    }

    const chatId = yield* Effect.map(HttpRouter.params, (params) => decodeChatId(params["id"]));
    if (chatId === undefined) {
      return html(chatErrorPage("Chat not found", "This chat does not exist."), 404);
    }

    const form = yield* readForm(request);
    const rawBody = typeof form["body"] === "string" ? form["body"] : "";
    const rawClientId =
      typeof form["clientMessageId"] === "string" && form["clientMessageId"].trim() !== ""
        ? form["clientMessageId"].trim()
        : undefined;

    const chatService = yield* ChatService;
    const sent = yield* Effect.result(
      chatService.sendMessage(user.id, chatId, {
        body: rawBody,
        clientMessageId: rawClientId,
      }),
    );

    if (Result.isSuccess(sent)) {
      return seeOther(`/chats/${chatId}`);
    }

    const failure = sent.failure;
    if (failure._tag === "ChatNotFoundError") {
      return html(chatErrorPage("Chat not found", "This chat does not exist."), 404);
    }
    if (failure._tag === "ChatForbiddenError") {
      return html(chatErrorPage("Access denied", "You are not a participant in this chat."), 403);
    }

    const chat = yield* chatService.getChat(user.id, chatId);
    const { messages } = yield* chatService.listRecentMessages(user.id, chatId, 100);
    const status =
      failure._tag === "ChatRateLimitError"
        ? 429
        : failure._tag === "ChatValidationError"
          ? 400
          : failure._tag === "ChatConflictError"
            ? 409
            : 500;
    const message =
      failure._tag === "InternalError"
        ? "Your message could not be sent just now. Please try again."
        : failure.message;

    return html(
      chatDetailPage({
        chat,
        messages,
        currentUserId: user.id,
        error: message,
      }),
      status,
    );
  }).pipe(
    Effect.catchTags({
      UnauthorizedError: () =>
        Effect.succeed(
          html(chatErrorPage("Sign in required", "Please sign in to send messages."), 401),
        ),
      ChatNotFoundError: () =>
        Effect.succeed(html(chatErrorPage("Chat not found", "This chat does not exist."), 404)),
      ChatForbiddenError: () =>
        Effect.succeed(
          html(chatErrorPage("Access denied", "You are not a participant in this chat."), 403),
        ),
      InternalError: () =>
        Effect.succeed(
          html(chatErrorPage("Chat unavailable", "Your message could not be sent just now."), 500),
        ),
    }),
  ),
);

// Listing-detail CTA target: opens or finds the one-to-one chat for
// `(listing, caller)` and redirects directly into `/chats/:id`.
const openListingChatRoute = HttpRouter.route("POST", "/listings/:id/chat", (request) =>
  Effect.gen(function* () {
    const user = yield* callerUser;
    if (!isSameOriginWrite(request)) {
      return html(chatErrorPage("Action refused", crossSiteFormMessage), 403);
    }

    const listingId = yield* Effect.map(HttpRouter.params, (params) =>
      decodeListingId(params["id"]),
    );
    if (listingId === undefined) {
      return html(chatErrorPage("Listing not found", "This listing is not available."), 404);
    }

    const chatService = yield* ChatService;
    const chat = yield* chatService.openForListing(user.id, listingId);
    return seeOther(`/chats/${chat.id}`);
  }).pipe(
    Effect.catchTags({
      UnauthorizedError: () =>
        Effect.succeed(
          html(chatErrorPage("Sign in required", "Please sign in to message the lister."), 401),
        ),
      ListingNotFoundError: () =>
        Effect.succeed(
          html(chatErrorPage("Listing not found", "This listing is not available."), 404),
        ),
      ChatSelfNotAllowedError: () =>
        Effect.succeed(
          html(
            chatErrorPage("Cannot message yourself", "You cannot open a chat on your own listing."),
            400,
          ),
        ),
      InternalError: () =>
        Effect.succeed(
          html(chatErrorPage("Chat unavailable", "Could not start this chat just now."), 500),
        ),
    }),
  ),
);

export const ChatPageRoutes = [
  chatsInboxRoute,
  chatDetailRoute,
  postChatMessageRoute,
  openListingChatRoute,
];
