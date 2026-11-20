import { PrivateApi } from "@/api/private";
import { callerUser } from "@/handlers/private/caller";
import { ChatService } from "@/services/chat.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

/*
 * Authenticated JSON endpoints for one-to-one chats. Identity comes strictly
 * from the session cookie verified by `AuthMiddleware` plus the stored account
 * row (`callerUser`), never from request fields. Every error raised by
 * `ChatService` already carries its `httpApiStatus`.
 */
export const ChatHandler = HttpApiBuilder.group(PrivateApi, "chat-group", (handlers) =>
  handlers
    .handle("inbox", () =>
      Effect.gen(function* () {
        const user = yield* callerUser;
        const chatService = yield* ChatService;
        return yield* chatService.listInbox(user.id);
      }),
    )
    .handle("open", ({ payload }) =>
      Effect.gen(function* () {
        const user = yield* callerUser;
        const chatService = yield* ChatService;
        return yield* chatService.openForListing(user.id, payload.listingId);
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const user = yield* callerUser;
        const chatService = yield* ChatService;
        return yield* chatService.getChat(user.id, params.id);
      }),
    )
    .handle("messages", ({ params, query }) =>
      Effect.gen(function* () {
        const user = yield* callerUser;
        const chatService = yield* ChatService;
        return yield* chatService.listMessages(user.id, params.id, {
          after: query.after,
          limit: query.limit,
        });
      }),
    )
    .handle("post-message", ({ params, payload }) =>
      Effect.gen(function* () {
        const user = yield* callerUser;
        const chatService = yield* ChatService;
        return yield* chatService.sendMessage(user.id, params.id, {
          body: payload.body,
          clientMessageId: payload.clientMessageId,
        });
      }),
    )
    .handle("mark-read", ({ params, payload }) =>
      Effect.gen(function* () {
        const user = yield* callerUser;
        const chatService = yield* ChatService;
        return yield* chatService.markRead(user.id, params.id, payload.seq);
      }),
    ),
);
