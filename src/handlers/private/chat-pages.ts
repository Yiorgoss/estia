import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_MESSAGE_PAGE_MAX_LIMIT,
  decodeChatId,
  SendMessageInput,
} from "@/db/schema/Chat";
import type { ChatId, UserId } from "@/db/schema/brands";
import { decodeListingId } from "@/db/schema/Listing";
import { chatErrorPage, chatInboxPage, chatThreadPage } from "@/frontend/pages/chats";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import { callerId } from "@/handlers/private/caller";
import {
  ChatService,
  type ChatNotFoundError,
  type ChatRateLimitedError,
  type ChatValidationError,
} from "@/services/chat.service";
import { ListingNotFoundError } from "@/services/listing.service";
import type { InternalError } from "@/services/user.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";
import { Effect, Option, Schema } from "effect";

/*
 * The browser paths for chats. They live on the private router, so
 * `AuthMiddleware` gates them - a signed-out visitor gets the sign-in prompt page,
 * never the JSON API's 401 body - and every write also passes the shared origin
 * check, because a sibling site can post these forms with the session attached.
 *
 * A successful write answers with a 303 to the thread, so a refresh cannot repeat
 * it. A refused one is explained on the page the person was looking at.
 */

type ChatPageError =
  | ChatNotFoundError
  | ChatValidationError
  | ChatRateLimitedError
  | ListingNotFoundError
  | InternalError;

const respond = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

const seeOther = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location, { status: 303 });

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

const crossSiteResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(chatErrorPage("That form did not come from this site", crossSiteFormMessage), 403);

const missingChatResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(chatErrorPage("Chat not found", "That chat does not exist, or it is not yours."), 404);

const unavailableResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(
    chatErrorPage(
      "Chats are unavailable just now",
      "Chats could not be loaded just now. Please try again.",
    ),
    500,
  );

/*
 * A form carries the message and, optionally, the id its own page generated for
 * this submit. The id is what makes a double post land on one row; a form that
 * repeats a field arrives as an array and is a bad request, not a first value.
 */
const decodeMessageForm = (
  params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
):
  | { readonly ok: true; readonly input: typeof SendMessageInput.Type }
  | { readonly ok: false; readonly message: string } => {
  const body = params["body"];
  const clientMessageId = params["clientMessageId"];
  const decoded = Schema.decodeUnknownOption(SendMessageInput)({
    body: typeof body === "string" ? body : "",
    ...(typeof clientMessageId === "string" && clientMessageId !== "" ? { clientMessageId } : {}),
  });
  return Option.isSome(decoded)
    ? { ok: true, input: decoded.value }
    : { ok: false, message: `Write a message of 1 to ${CHAT_MESSAGE_MAX_LENGTH} characters.` };
};

const describeError = (
  error: ChatPageError,
): { readonly title: string; readonly message: string; readonly status: number } => {
  switch (error._tag) {
    case "ChatNotFoundError":
      return {
        title: "Chat not found",
        message: "That chat does not exist, or it is not yours.",
        status: 404,
      };
    case "ListingNotFoundError":
      return {
        title: "That listing is not available",
        message: "The listing does not exist, or it is no longer published.",
        status: 404,
      };
    case "ChatValidationError":
      return { title: "That message could not be sent", message: error.message, status: 400 };
    case "ChatRateLimitedError":
      return {
        title: "You are sending messages too quickly",
        message: "Wait a few seconds, then send your message again.",
        status: 429,
      };
    case "InternalError":
      return {
        title: "Chats are unavailable just now",
        message: "That could not be completed just now. Please try again.",
        status: 500,
      };
  }
};

const threadErrorResponse = (
  userId: typeof UserId.Type,
  chatId: typeof ChatId.Type,
  failure: { readonly title: string; readonly message: string; readonly status: number },
  draft: string | undefined,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, ChatService> =>
  Effect.gen(function* () {
    const chats = yield* ChatService;
    const detail = yield* chats.openChat(userId, chatId);
    const messages = yield* chats.listMessages(userId, chatId, {
      after: Math.max(0, detail.lastSeq - CHAT_MESSAGE_PAGE_MAX_LIMIT),
      limit: CHAT_MESSAGE_PAGE_MAX_LIMIT,
    });
    return respond(
      chatThreadPage(detail, messages, {
        userId,
        error: failure.message,
        ...(draft === undefined || draft === "" ? {} : { draft }),
      }),
      failure.status,
    );
  }).pipe(
    Effect.orElseSucceed(() =>
      respond(
        chatErrorPage(failure.title, failure.message, {
          backHref: `/chats/${chatId}`,
          backLabel: "Back to the chat",
        }),
        failure.status,
      ),
    ),
  );

const chatInboxRoute = HttpRouter.route("GET", "/chats", () =>
  Effect.gen(function* () {
    const userId = yield* callerId;
    const chats = yield* ChatService;
    const inbox = yield* chats.listInbox(userId);
    return respond(chatInboxPage(inbox), 200);
  }).pipe(
    // A failed list is still a page: the empty inbox would read as "you have no
    // chats", which is a different claim from "they could not be loaded".
    Effect.catchTag("InternalError", () =>
      Effect.succeed(
        respond(
          chatInboxPage(
            { items: [] },
            { error: "Your chats could not be loaded just now. Please try again." },
          ),
          500,
        ),
      ),
    ),
  ),
);

/*
 * One thread, and the act of reading it: `openChat` moves the caller's read mark
 * to the newest sequence number, which is what clears the inbox badge. The page
 * renders the newest page of the archive, not the oldest, and the client script
 * only asks for what comes after the last sequence number it got.
 */
const chatThreadRoute = HttpRouter.route("GET", "/chats/:id", () =>
  Effect.gen(function* () {
    const id = yield* Effect.map(HttpRouter.params, (params) => decodeChatId(params["id"]));
    if (id === undefined) return missingChatResponse();

    const userId = yield* callerId;
    const chats = yield* ChatService;
    const detail = yield* chats.openChat(userId, id);
    const messages = yield* chats.listMessages(userId, id, {
      after: Math.max(0, detail.lastSeq - CHAT_MESSAGE_PAGE_MAX_LIMIT),
      limit: CHAT_MESSAGE_PAGE_MAX_LIMIT,
    });
    return respond(chatThreadPage(detail, messages, { userId }), 200);
  }).pipe(
    Effect.catchTags({
      ChatNotFoundError: () => Effect.succeed(missingChatResponse()),
      InternalError: () => Effect.succeed(unavailableResponse()),
    }),
  ),
);

/*
 * The listing detail page's contact control. The thread is the list of messages
 * between the listing's owner and the person who asked about it, so this either
 * reopens that thread or opens it with this message as its first one - never a
 * second contact surface next to it.
 */
const startChatRoute = HttpRouter.route("POST", "/chats/start", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const params = yield* readForm(request);
    const rawListingId = params["listingId"];
    const listingId = decodeListingId(typeof rawListingId === "string" ? rawListingId : undefined);
    if (listingId === undefined) {
      return respond(
        chatErrorPage("That listing could not be found", "Open the listing and try again."),
        400,
      );
    }

    const backTo = {
      backHref: `/listings/${listingId}`,
      backLabel: "Back to the listing",
    } as const;
    const decoded = decodeMessageForm(params);
    if (!decoded.ok) {
      return respond(chatErrorPage("That message could not be sent", decoded.message, backTo), 400);
    }

    const userId = yield* callerId;
    const chats = yield* ChatService;
    return yield* chats.startChat(userId, listingId, decoded.input).pipe(
      Effect.map((started) => seeOther(`/chats/${started.chatId}`)),
      Effect.catch((error: ChatPageError) => {
        const { title, message, status } = describeError(error);
        return Effect.succeed(respond(chatErrorPage(title, message, backTo), status));
      }),
    );
  }),
);

/*
 * The no-socket send path. A rejected message is shown on the thread it was
 * written on, so the person can fix it without navigating; the thread is re-read
 * first, so the page carries the chat as it stands, including the messages that
 * arrived while the form was being filled in.
 */
const sendMessageRoute = HttpRouter.route("POST", "/chats/:id/messages", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const id = yield* Effect.map(HttpRouter.params, (params) => decodeChatId(params["id"]));
    if (id === undefined) return missingChatResponse();

    const params = yield* readForm(request);
    const rawBody = params["body"];
    const draft = typeof rawBody === "string" ? rawBody : undefined;
    const decoded = decodeMessageForm(params);
    if (!decoded.ok) {
      const userId = yield* callerId;
      return yield* threadErrorResponse(
        userId,
        id,
        { title: "That message could not be sent", message: decoded.message, status: 400 },
        draft,
      );
    }

    const userId = yield* callerId;
    const chats = yield* ChatService;
    return yield* chats.sendMessage(userId, id, decoded.input).pipe(
      Effect.map(() => seeOther(`/chats/${id}`)),
      Effect.catch((error: ChatPageError) => {
        const failure = describeError(error);
        // An unknown or foreign chat has no thread to re-read.
        if (error._tag === "ChatNotFoundError") {
          return Effect.succeed(
            respond(chatErrorPage(failure.title, failure.message), failure.status),
          );
        }
        return threadErrorResponse(userId, id, failure, decoded.input.body);
      }),
    );
  }),
);

export const ChatPageRoutes = [chatInboxRoute, chatThreadRoute, startChatRoute, sendMessageRoute];
