import { CHAT_APPEND_PATH, type ChatMessageRow } from "@/durable-objects/chat-core";
import { CHAT_TICKET_HEADER } from "@/durable-objects/chat-ticket";
import { Schema, Context, Effect, Layer } from "effect";

/*
 * The Worker's client for the chat object. It is a repository in the same sense
 * as the others in this folder: the one place that speaks the object's wire
 * contract. A message is posted to the object rather than inserted here, because
 * the object is the only writer of `chat_messages` and the only allocator of
 * `seq` - the no-socket fallback and a live socket therefore produce the same
 * ordering instead of two writers racing for it.
 *
 * The ticket travels in a header and the object verifies it, so this client never
 * sends an account id the object would have to trust.
 */

export type ChatAppendOutcome =
  | { readonly _tag: "stored"; readonly message: ChatMessageRow }
  | { readonly _tag: "rate_limited" }
  | { readonly _tag: "invalid"; readonly message: string };

export class ChatObjectError extends Schema.TaggedError<ChatObjectError>()("ChatObjectError", {
  cause: Schema.Unknown,
}) {}

export interface ChatObject {
  readonly append: (values: {
    readonly chatId: number;
    readonly ticket: string;
    readonly clientMessageId: string;
    readonly body: string;
  }) => Effect.Effect<ChatAppendOutcome, ChatObjectError>;
}

export const ChatObject = Context.Service<ChatObject>("ChatObject");

/*
 * The object answers with the row it stored, so the caller sees the sequence
 * number the object allocated rather than a number it guessed. Anything that is
 * not one of the object's own answers is a failure, not an empty message.
 */
const decodeMessage = (value: unknown): ChatMessageRow | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, chatId, seq, senderId, body, clientMessageId, createdAt } = value as Record<
    string,
    unknown
  >;
  if (
    typeof id !== "number" ||
    typeof chatId !== "number" ||
    typeof seq !== "number" ||
    typeof senderId !== "string" ||
    typeof body !== "string" ||
    typeof clientMessageId !== "string" ||
    typeof createdAt !== "number"
  ) {
    return undefined;
  }
  return { id, chatId, seq, senderId, body, clientMessageId, createdAt };
};

export const ChatObjectLive = (namespace: DurableObjectNamespace) =>
  Layer.succeed(ChatObject, {
    append: (values) =>
      Effect.tryPromise({
        try: async (): Promise<ChatAppendOutcome> => {
          const stub = namespace.get(namespace.idFromName(String(values.chatId)));
          const response = await stub.fetch(
            new Request(`https://chat.internal${CHAT_APPEND_PATH}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [CHAT_TICKET_HEADER]: values.ticket,
              },
              body: JSON.stringify({
                clientMessageId: values.clientMessageId,
                body: values.body,
              }),
            }),
          );

          if (response.status === 429) return { _tag: "rate_limited" };
          if (response.status === 400) {
            const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
            return {
              _tag: "invalid",
              message:
                typeof payload.message === "string" ? payload.message : "That message was refused.",
            };
          }
          if (!response.ok) {
            throw new Error(`The chat object answered ${response.status}`);
          }

          const payload = (await response.json()) as { message?: unknown };
          const message = decodeMessage(payload.message);
          if (message === undefined) throw new Error("The chat object returned no message");
          return { _tag: "stored", message };
        },
        catch: (cause) => new ChatObjectError({ cause }),
      }),
  } satisfies ChatObject);
