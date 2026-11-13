import { DurableObject } from "cloudflare:workers";
import {
  CHAT_APPEND_PATH,
  createChatCore,
  type ChatCore,
  type ChatMessageRow,
  type ChatMessageStore,
} from "./chat-core";
import { verifyChatTicket } from "./chat-ticket";

/*
 * One Durable Object per chat, and the only writer of that chat's messages.
 *
 * It is deliberately thin. The behaviour that a test can drive without a workerd
 * runtime lives in `./chat-core.ts`; this class owns the parts that only exist in
 * the runtime: the `WebSocketPair`, the 101 response that upgrades a connection,
 * and the D1 statements behind the message store.
 *
 * The constructor is cheap on purpose. Hibernation re-runs it every time the
 * object wakes, so it must not read storage, D1, or a secret; the sequence
 * counter is loaded on the first send and the ticket is verified per event.
 */

export interface ChatEnv {
  readonly DB: D1Database;
  readonly JWT_SECRET: string;
}

const MESSAGE_COLUMNS = "id, chat_id, seq, sender_id, body, client_message_id, created_at";

const toMessageRow = (row: Record<string, unknown>): ChatMessageRow => ({
  id: Number(row["id"]),
  chatId: Number(row["chat_id"]),
  seq: Number(row["seq"]),
  senderId: String(row["sender_id"]),
  body: String(row["body"]),
  clientMessageId: String(row["client_message_id"]),
  createdAt: Number(row["created_at"]),
});

// D1 reports a violated unique index in the error text, and there is no typed
// error to switch on. The two indexes on `chat_messages` are the only ones this
// store can trip, so a match is the retried-send case.
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("UNIQUE constraint failed");

/*
 * The archive, written in D1. The insert and the chat's projection move in one
 * batch, which D1 runs as a transaction, so the row and the inbox's `last_seq`
 * cannot disagree. A client id the same sender already holds answers with the row
 * it already wrote, which is what makes a reconnect's retry idempotent.
 */
const d1MessageStore = (db: D1Database): ChatMessageStore => {
  const findByClientMessageId = (chatId: number, senderId: string, clientMessageId: string) =>
    db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM chat_messages
          WHERE chat_id = ? AND sender_id = ? AND client_message_id = ?`,
      )
      .bind(chatId, senderId, clientMessageId)
      .first<Record<string, unknown>>();

  return {
    append: async (values) => {
      const existing = await findByClientMessageId(
        values.chatId,
        values.senderId,
        values.clientMessageId,
      );
      if (existing !== null) return { _tag: "duplicate", message: toMessageRow(existing) };

      try {
        const [inserted] = await db.batch<Record<string, unknown>>([
          db
            .prepare(
              `INSERT INTO chat_messages (chat_id, seq, sender_id, body, client_message_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               RETURNING ${MESSAGE_COLUMNS}`,
            )
            .bind(
              values.chatId,
              values.seq,
              values.senderId,
              values.body,
              values.clientMessageId,
              values.createdAt,
            ),
          db
            .prepare(`UPDATE chats SET last_seq = ?, last_message_at = ? WHERE id = ?`)
            .bind(values.seq, values.createdAt, values.chatId),
        ]);
        const row = inserted?.results[0];
        if (row === undefined) throw new Error("A chat message insert returned no row");
        return { _tag: "stored", message: toMessageRow(row) };
      } catch (error) {
        // Two sends can never share a sequence number, so the only unique index a
        // write here can trip is the sender's client id one: the row exists, answer
        // with it.
        if (!isUniqueViolation(error)) throw error;
        const written = await findByClientMessageId(
          values.chatId,
          values.senderId,
          values.clientMessageId,
        );
        if (written === null) throw error;
        return { _tag: "duplicate", message: toMessageRow(written) };
      }
    },
    listAfter: async (chatId, afterSeq, limit) => {
      const { results } = await db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE chat_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        )
        .bind(chatId, afterSeq, limit)
        .all<Record<string, unknown>>();
      return results.map(toMessageRow);
    },
  };
};

interface AppendBody {
  readonly clientMessageId: string;
  readonly body: string;
}

const readAppendBody = async (request: Request): Promise<AppendBody | undefined> => {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { clientMessageId, body } = parsed as Record<string, unknown>;
  if (typeof clientMessageId !== "string" || typeof body !== "string") return undefined;
  return { clientMessageId, body };
};

export class Chat extends DurableObject<ChatEnv> {
  private readonly core: ChatCore;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);

    // The object is addressed by `idFromName(String(chatId))`, so the id in the
    // name is the only thing that tells it which thread it is. A name that is not
    // a chat id is a deployment defect, not a request problem.
    const chatId = Number(ctx.id.name);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      throw new Error(`A chat object was addressed by a non-chat name: ${String(ctx.id.name)}`);
    }

    this.core = createChatCore(
      {
        storage: {
          get: <T>(key: string) => ctx.storage.get<T>(key),
          put: (entries) => ctx.storage.put(entries),
        },
        getWebSockets: (tag) => ctx.getWebSockets(tag),
        setAlarm: (scheduledTime) => ctx.storage.setAlarm(scheduledTime),
      },
      d1MessageStore(env.DB),
      {
        chatId,
        // The object's clock is the wall clock the archive stores. Tests inject
        // their own, which is how an expiry and a rate window are exercised
        // without waiting for them.
        clock: () => Date.now(),
        verifyTicket: (raw) => verifyChatTicket(env.JWT_SECRET, raw, Date.now()),
      },
    );
  }

  /*
   * Two internal entry points. An upgrade needs a valid ticket and answers with
   * the 101 the Worker hands back to the browser; a POST is the no-socket fallback
   * and goes through the same append path, so a message posted without a socket
   * gets the same sequence number and the same fan-out it would have had live.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

    if (upgrade) {
      const decision = await this.core.authorise(request);
      if (decision._tag === "refused") {
        return new Response(decision.reason, { status: decision.status });
      }

      const pair = new WebSocketPair();
      const server = pair[1];
      // The tag is the account, which is what makes a per-person fan-out or a
      // lookup by identity possible without trusting a frame.
      this.ctx.acceptWebSocket(server, [decision.ticket.userId]);
      await this.core.accept(server, decision.ticket, decision.after);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (request.method === "POST" && url.pathname === CHAT_APPEND_PATH) {
      const decision = await this.core.authorise(request);
      if (decision._tag === "refused") {
        return Response.json({ error: decision.reason }, { status: decision.status });
      }

      const payload = await readAppendBody(request);
      if (payload === undefined) {
        return Response.json({ error: "invalid_message" }, { status: 400 });
      }

      const result = await this.core.append(decision.ticket, payload);
      if (result._tag === "invalid") {
        return Response.json({ error: "invalid_message", message: result.reason }, { status: 400 });
      }
      if (result._tag === "rate_limited") {
        return Response.json({ error: "rate_limited" }, { status: 429 });
      }
      return Response.json({ message: result.message });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.core.receive(socket, message);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    // The hibernation API keeps no socket registry of its own, so completing the
    // handshake is the whole job here.
    this.core.close(socket, code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.core.close(socket, 1011, "socket_error");
  }

  async alarm(): Promise<void> {
    await this.core.alarm();
  }
}
