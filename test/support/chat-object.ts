import type { ChatMessageRow } from "@/durable-objects/chat-core";
import { verifyChatTicket } from "@/durable-objects/chat-ticket";
import { ChatObject, ChatObjectError, type ChatAppendOutcome } from "@/repos/chat-object.repo";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

/*
 * The chat object's contract for the unit harness.
 *
 * A Durable Object only runs under workerd, so this layer stands in for it while
 * the HTTP surface is exercised against the in-memory database: it verifies the
 * Worker's ticket exactly as the object does, allocates the chat's next sequence
 * number, writes the row, and moves the chat's projection. What it does not
 * reproduce is the object's single-writer serialisation - that is what the real
 * object is for, and `scripts/chat-socket-e2e.mjs` drives it end to end against a
 * real workerd runtime.
 */

// The harness's own signing secret. It is shared with the app layer in
// `test/support/api.ts` so the tickets `ChatTicketService` signs are the ones
// this layer verifies.
export const TEST_JWT_SECRET = "listings-test-secret-listings-test-secret";

const toRow = (row: Record<string, unknown>): ChatMessageRow => ({
  id: Number(row["id"]),
  chatId: Number(row["chatId"]),
  seq: Number(row["seq"]),
  senderId: String(row["senderId"]),
  body: String(row["body"]),
  clientMessageId: String(row["clientMessageId"]),
  createdAt: Number(row["createdAt"]),
});

export const ChatObjectTestLive = Layer.effect(
  ChatObject,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      append: (values) =>
        Effect.gen(function* () {
          const ticket = yield* Effect.tryPromise({
            try: () => verifyChatTicket(TEST_JWT_SECRET, values.ticket, Date.now()),
            catch: (cause) => new ChatObjectError({ cause }),
          });
          if (ticket === undefined || ticket.chatId !== values.chatId) {
            return yield* Effect.fail(
              new ChatObjectError({ cause: "The chat ticket did not verify" }),
            );
          }

          const existing = yield* sql<Record<string, unknown>>`
              SELECT * FROM chat_messages
               WHERE chat_id = ${values.chatId}
                 AND client_message_id = ${values.clientMessageId}
            `;
          const found = existing[0];
          if (found !== undefined) {
            return { _tag: "stored", message: toRow(found) } satisfies ChatAppendOutcome;
          }

          const chats = yield* sql<Record<string, unknown>>`
              SELECT last_seq FROM chats WHERE id = ${values.chatId}
            `;
          const lastSeq = Number(chats[0]?.["lastSeq"] ?? 0);
          const seq = lastSeq + 1;
          const now = Date.now();
          const rows = yield* sql<Record<string, unknown>>`
              INSERT INTO chat_messages (chat_id, seq, sender_id, body, client_message_id, created_at)
              VALUES (${values.chatId}, ${seq}, ${ticket.userId}, ${values.body}, ${values.clientMessageId}, ${now})
              RETURNING *
            `;
          yield* sql`
              UPDATE chats
                 SET last_seq = ${seq}, last_message_at = ${now}
               WHERE id = ${values.chatId}
            `;

          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(
              new ChatObjectError({ cause: "The chat message insert returned no row" }),
            );
          }
          return { _tag: "stored", message: toRow(row) } satisfies ChatAppendOutcome;
        }).pipe(
          // A driver failure is the object being unreachable, which is the same
          // error the real client reports.
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(new ChatObjectError({ cause })),
          }),
        ),
    } satisfies ChatObject;
  }),
);
