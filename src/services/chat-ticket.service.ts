import { Clock, Config, Context, Effect, Layer, Schema } from "effect";
import { CHAT_TICKET_TTL_MS, signChatTicket } from "@/durable-objects/chat-ticket";

/*
 * The Worker's half of the chat object's identity contract. The session cookie
 * proves the account and D1 proves the membership; this service turns that proof
 * into the short ticket the object verifies.
 *
 * It is a service rather than a helper so the secret is read once from the
 * configuration and every caller - the socket upgrade and the no-socket message
 * path - signs through the same implementation. The expiry is read from the
 * clock at signing time, so a test can drive it like any other clock read.
 */

export class ChatTicketSigningError extends Schema.TaggedError<ChatTicketSigningError>()(
  "ChatTicketSigningError",
  { cause: Schema.Unknown },
) {}

export interface ChatTicketService {
  readonly sign: (values: {
    readonly userId: string;
    readonly chatId: number;
    readonly sessionExpiresAt?: number;
  }) => Effect.Effect<string, ChatTicketSigningError>;
}

export const ChatTicketService = Context.Service<ChatTicketService>("ChatTicketService");

export const ChatTicketServiceLive = Layer.effect(
  ChatTicketService,
  Effect.gen(function* () {
    const secret = yield* Config.String("JWT_SECRET");

    return {
      sign: (values) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const exp = now + CHAT_TICKET_TTL_MS;
          return yield* Effect.tryPromise({
            try: () =>
              signChatTicket(secret, {
                userId: values.userId,
                chatId: values.chatId,
                exp,
                sessionExp: values.sessionExpiresAt ?? exp,
              }),
            catch: (cause) => new ChatTicketSigningError({ cause }),
          });
        }),
    } satisfies ChatTicketService;
  }),
);
