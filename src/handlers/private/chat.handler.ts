import { PrivateApi } from "@/api/private";
import { callerId } from "@/handlers/private/caller";
import { ChatService } from "@/services/chat.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

/*
 * The chat JSON endpoints. The caller is always the cookie's account, so no
 * request names a user and no handler has to check that the two agree; the
 * service decides what that account may see, and a chat it does not belong to is
 * the same 404 as one that does not exist.
 *
 * A send goes to the chat object through the service, not to D1, which is what
 * keeps one allocator of sequence numbers behind both this path and the socket.
 */
export const ChatHandler = HttpApiBuilder.group(PrivateApi, "chat-group", (handlers) =>
  handlers
    .handle("inbox", () =>
      Effect.gen(function* () {
        const userId = yield* callerId;
        const chats = yield* ChatService;
        return yield* chats.listInbox(userId);
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const userId = yield* callerId;
        const chats = yield* ChatService;
        return yield* chats.openChat(userId, params.id);
      }),
    )
    .handle("messages", ({ params, query }) =>
      Effect.gen(function* () {
        const userId = yield* callerId;
        const chats = yield* ChatService;
        // `after` catches up after a reconnect, `before` pages older history,
        // and `limit` already carries its default from the query codec.
        return yield* chats.listMessages(userId, params.id, {
          ...(query.after === undefined ? {} : { after: query.after }),
          ...(query.before === undefined ? {} : { before: query.before }),
          limit: query.limit,
        });
      }),
    )
    .handle("send", ({ params, payload }) =>
      Effect.gen(function* () {
        const userId = yield* callerId;
        const chats = yield* ChatService;
        return yield* chats.sendMessage(userId, params.id, payload);
      }),
    )
    .handle("read", ({ params, payload }) =>
      Effect.gen(function* () {
        const userId = yield* callerId;
        const chats = yield* ChatService;
        return yield* chats.markRead(userId, params.id, payload.seq);
      }),
    ),
);
