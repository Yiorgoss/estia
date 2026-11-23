import { ChatId, UserId } from "@/db/schema/brands";
import { ChatMessageSchema, type ChatMessage } from "@/db/schema/Chat";
import { ChatConflictError, ChatRateLimitError, ChatValidationError } from "@/services/chat-errors";
import { CHAT_TICKET_HEADER, signShortChatTicket } from "@/services/chat-ticket";
import { InternalError } from "@/errors";
import { Config, Context, Effect, Layer, Schema } from "effect";

/*
 * The Effect boundary into the `Chat` Durable Object namespace.
 *
 * The HTTP fallback POST and read-broadcast paths go through this service so
 * that the `Chat` Durable Object remains the sole writer of `chat_messages` and
 * the sole allocator of `seq`, whether a message came over a WebSocket or an
 * ordinary HTTP POST. Every call signs a short-lived HMAC ticket with
 * `JWT_SECRET` so the DO never trusts a client-supplied user id.
 */

export interface ChatGateway {
  readonly postMessage: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
    input: { readonly body: string; readonly clientMessageId: string },
  ) => Effect.Effect<
    ChatMessage,
    ChatValidationError | ChatConflictError | ChatRateLimitError | InternalError
  >;

  readonly notifyRead: (
    chatId: typeof ChatId.Type,
    userId: typeof UserId.Type,
    lastReadSeq: number,
  ) => Effect.Effect<void, never>;
}

export const ChatGateway = Context.Service<ChatGateway>("ChatGateway");

const decodeMessage = (raw: unknown): Effect.Effect<ChatMessage, InternalError> =>
  Schema.decodeUnknownEffect(ChatMessageSchema)(raw).pipe(
    Effect.mapError(() => new InternalError()),
  );

export const ChatGatewayLive = (
  namespace: DurableObjectNamespace,
): Layer.Layer<ChatGateway, Config.ConfigError> =>
  Layer.effect(
    ChatGateway,
    Effect.gen(function* () {
      const secret = yield* Config.String("JWT_SECRET");

      const signedHeaders = (chatId: string, userId: string) =>
        Effect.gen(function* () {
          const ticket = yield* Effect.tryPromise({
            try: () => signShortChatTicket(secret, { userId, chatId }),
            catch: () => new InternalError(),
          });
          return {
            "content-type": "application/json",
            [CHAT_TICKET_HEADER]: ticket,
          };
        });

      return {
        postMessage: (chatId, userId, input) =>
          Effect.gen(function* () {
            const headers = yield* signedHeaders(chatId, userId);
            const stub = namespace.get(namespace.idFromName(chatId));
            const response = yield* Effect.tryPromise({
              try: () =>
                stub.fetch(
                  new Request(
                    `https://chat.internal/chats/${encodeURIComponent(chatId)}/messages`,
                    {
                      method: "POST",
                      headers,
                      body: JSON.stringify({
                        body: input.body,
                        clientMessageId: input.clientMessageId,
                      }),
                    },
                  ),
                ),
              catch: () => new InternalError(),
            });

            const parsed = yield* Effect.tryPromise({
              try: () => response.json() as Promise<unknown>,
              catch: () => new InternalError(),
            });

            if (response.status === 200) {
              return yield* decodeMessage(parsed);
            }

            const record =
              typeof parsed === "object" && parsed !== null
                ? (parsed as Record<string, unknown>)
                : {};
            const message =
              typeof record["error"] === "string" ? record["error"] : "Chat request failed.";

            if (response.status === 400) {
              return yield* Effect.fail(new ChatValidationError({ message }));
            }
            if (response.status === 409) {
              return yield* Effect.fail(new ChatConflictError({ message }));
            }
            if (response.status === 429) {
              const retryAfterMs =
                typeof record["retryAfterMs"] === "number" &&
                Number.isFinite(record["retryAfterMs"])
                  ? Math.max(100, Math.round(record["retryAfterMs"]))
                  : 1000;
              return yield* Effect.fail(new ChatRateLimitError({ message, retryAfterMs }));
            }

            return yield* Effect.fail(new InternalError());
          }),

        notifyRead: (chatId, userId, lastReadSeq) =>
          Effect.gen(function* () {
            const headers = yield* signedHeaders(chatId, userId);
            const stub = namespace.get(namespace.idFromName(chatId));
            yield* Effect.tryPromise({
              try: () =>
                stub.fetch(
                  new Request(`https://chat.internal/chats/${encodeURIComponent(chatId)}/read`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ lastReadSeq }),
                  }),
                ),
              catch: (error) => error,
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Chat read notification failed", { chatId, error }),
            ),
            Effect.asVoid,
          ),
      } satisfies ChatGateway;
    }),
  );
