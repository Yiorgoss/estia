import { DurableObject } from "cloudflare:workers";
import {
  CHAT_CLOSE_AUTH_EXPIRED,
  CHAT_SOCKET_MAX_LIFETIME_SECONDS,
  CHAT_TICKET_HEADER,
  verifyChatTicket,
} from "@/services/chat-ticket";

/*
 * One Durable Object per one-to-one chat.
 *
 * Responsibilities:
 * - Own per-chat message ordering (`seq`) so two concurrent writes can never
 *   receive the same sequence number.
 * - Act as the sole writer of `chat_messages` rows (both live WebSocket sends
 *   and the no-socket HTTP POST fallback enter this object).
 * - Accept and fan out across hibernatable WebSockets (`ctx.acceptWebSocket`,
 *   `webSocketMessage`, `webSocketClose`, `serializeAttachment`).
 * - Replay gaps from D1 on reconnect (`?after=<seq>` or `{ type: "sync" }`).
 * - Enforce a per-sender rate limit persisted in DO storage.
 * - Bound open sockets to access-token expiry via a single DO alarm.
 *
 * The constructor stays trivial because Cloudflare hibernation re-runs it
 * whenever a sleeping object wakes up for a WebSocket frame or alarm.
 */

export interface ChatDurableObjectEnv {
  readonly DB: D1Database;
  readonly JWT_SECRET: string;
  readonly CHAT_RATE_LIMIT_MAX?: string | undefined;
  readonly CHAT_RATE_LIMIT_WINDOW_MS?: string | undefined;
}

export interface ChatSocketAttachment {
  readonly userId: string;
  readonly chatId: string;
  // Epoch milliseconds when this socket must be closed for re-auth.
  readonly exp: number;
}

export interface PersistedChatMessage {
  readonly id: number;
  readonly chatId: string;
  readonly seq: number;
  readonly senderId: string;
  readonly clientMessageId: string;
  readonly body: string;
  readonly createdAt: number;
}

interface StoredMessageRow {
  readonly id: number;
  readonly chat_id: string;
  readonly seq: number;
  readonly sender_id: string;
  readonly client_message_id: string;
  readonly body: string;
  readonly created_at: number;
}

interface RateBucket {
  readonly tokens: number;
  readonly updatedAt: number;
}

const DEFAULT_RATE_LIMIT_MAX = 10;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_BODY_LENGTH = 2000;
const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;
const MAX_REPLAY_LIMIT = 100;

const STORAGE_CHAT_ID = "chatId";
const STORAGE_LAST_SEQ = "lastSeq";
const rateKey = (userId: string) => `rate:${userId}`;

type PersistOutcome =
  | { readonly ok: true; readonly message: PersistedChatMessage; readonly deduplicated: boolean }
  | { readonly ok: false; readonly status: 400 | 409 | 429 | 500; readonly code: string; readonly error: string; readonly retryAfterMs?: number };

const mapMessageRow = (row: StoredMessageRow): PersistedChatMessage => ({
  id: Number(row.id),
  chatId: String(row.chat_id),
  seq: Number(row.seq),
  senderId: String(row.sender_id),
  clientMessageId: String(row.client_message_id),
  body: String(row.body),
  createdAt: Number(row.created_at),
});

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInt = (raw: string | null): number | null => {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const jsonResponse = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

const safeSend = (ws: WebSocket, payload: unknown): void => {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // A peer socket that disconnected mid-broadcast must not abort delivery to
    // other sockets or fail an already-committed message write.
  }
};

const readAttachment = (ws: WebSocket): ChatSocketAttachment | null => {
  const raw = ws.deserializeAttachment() as Partial<ChatSocketAttachment> | null | undefined;
  if (
    raw == null ||
    typeof raw.userId !== "string" ||
    raw.userId.length === 0 ||
    typeof raw.chatId !== "string" ||
    raw.chatId.length === 0 ||
    typeof raw.exp !== "number" ||
    !Number.isFinite(raw.exp)
  ) {
    return null;
  }
  return { userId: raw.userId, chatId: raw.chatId, exp: raw.exp };
};

export class Chat extends DurableObject<ChatDurableObjectEnv> {
  // Serializes message writes inside this live isolate so awaiting D1 I/O never
  // allows two concurrent sends to race on `lastSeq`. Resetting to a resolved
  // promise after hibernation is safe because hibernation only occurs when no
  // work is in flight.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ChatDurableObjectEnv) {
    super(ctx, env);
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private rateLimitConfig(): { readonly max: number; readonly windowMs: number } {
    return {
      max: parsePositiveInt(this.env.CHAT_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
      windowMs: parsePositiveInt(this.env.CHAT_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/chats\/([^/]+)\/(socket|messages|read)$/.exec(url.pathname);
    if (!match) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    let chatId: string;
    try {
      chatId = decodeURIComponent(match[1] ?? "");
    } catch {
      return jsonResponse({ error: "Not found" }, 404);
    }
    const action = match[2];

    const ticketHeader = request.headers.get(CHAT_TICKET_HEADER) ?? "";
    const ticket = await verifyChatTicket(this.env.JWT_SECRET ?? "", ticketHeader, chatId);
    if (ticket === null) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const boundChatId = await this.ctx.storage.get<string>(STORAGE_CHAT_ID);
    if (boundChatId !== undefined && boundChatId !== chatId) {
      return jsonResponse({ error: "Forbidden" }, 403);
    }
    if (boundChatId === undefined) {
      await this.ctx.storage.put(STORAGE_CHAT_ID, chatId);
    }

    if (action === "socket") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse({ error: "Upgrade required" }, 426);
      }
      return this.handleSocketUpgrade(url, ticket.chatId, ticket.userId, ticket.socketExp ?? ticket.exp);
    }

    if (action === "messages" && request.method === "POST") {
      return this.handleHttpMessagePost(request, ticket.chatId, ticket.userId);
    }

    if (action === "read" && request.method === "POST") {
      return this.handleHttpReadNotify(request, ticket.chatId, ticket.userId);
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  private async handleSocketUpgrade(
    url: URL,
    chatId: string,
    userId: string,
    socketExpSeconds: number,
  ): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) {
      return jsonResponse({ error: "WebSocket unavailable" }, 500);
    }

    const nowMs = Date.now();
    const maxExpMs = nowMs + CHAT_SOCKET_MAX_LIFETIME_SECONDS * 1000;
    const expMs = Math.min(socketExpSeconds * 1000, maxExpMs);

    this.ctx.acceptWebSocket(server, [userId]);
    const attachment: ChatSocketAttachment = { userId, chatId, exp: expMs };
    server.serializeAttachment(attachment);

    await this.scheduleNextExpiryAlarm();

    safeSend(server, {
      type: "connected",
      chatId,
      userId,
      connections: this.ctx.getWebSockets().length,
    });

    const afterSeq = parseNonNegativeInt(url.searchParams.get("after"));
    if (afterSeq !== null) {
      const missed = await this.loadMessagesAfter(chatId, afterSeq);
      safeSend(server, {
        type: "replay",
        chatId,
        after: afterSeq,
        messages: missed,
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleHttpMessagePost(
    request: Request,
    chatId: string,
    userId: string,
  ): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    if (typeof payload !== "object" || payload === null) {
      return jsonResponse({ error: "Invalid payload" }, 400);
    }

    const record = payload as Record<string, unknown>;
    const body = typeof record["body"] === "string" ? record["body"] : "";
    const clientMessageId =
      typeof record["clientMessageId"] === "string" ? record["clientMessageId"] : "";

    const outcome = await this.enqueueWrite(() =>
      this.persistAndBroadcastMessage(chatId, userId, clientMessageId, body, undefined),
    );

    if (!outcome.ok) {
      const headers: Record<string, string> = {};
      if (outcome.retryAfterMs !== undefined) {
        headers["retry-after"] = String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)));
      }
      return jsonResponse(
        {
          code: outcome.code,
          error: outcome.error,
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        },
        outcome.status,
        headers,
      );
    }

    return jsonResponse(outcome.message, 200);
  }

  private async handleHttpReadNotify(
    request: Request,
    chatId: string,
    userId: string,
  ): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const lastReadSeq = record["lastReadSeq"];
    if (typeof lastReadSeq !== "number" || !Number.isInteger(lastReadSeq) || lastReadSeq < 0) {
      return jsonResponse({ error: "Invalid lastReadSeq" }, 400);
    }

    this.broadcastReadEvent(chatId, userId, lastReadSeq);
    return jsonResponse({ ok: true }, 200);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment === null || Date.now() >= attachment.exp) {
      ws.close(CHAT_CLOSE_AUTH_EXPIRED, "Session expired");
      return;
    }

    const rawText =
      typeof message === "string" ? message : new TextDecoder().decode(new Uint8Array(message));

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      safeSend(ws, { type: "error", code: "invalid_json", message: "Message must be valid JSON." });
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      safeSend(ws, { type: "error", code: "invalid_frame", message: "Message frame must be an object." });
      return;
    }

    const frame = parsed as Record<string, unknown>;
    const type = frame["type"];

    if (type === "ping") {
      safeSend(ws, {
        type: "pong",
        connections: this.ctx.getWebSockets().length,
      });
      return;
    }

    if (type === "sync") {
      const after = frame["after"];
      if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
        safeSend(ws, { type: "error", code: "invalid_after", message: "after must be a non-negative integer." });
        return;
      }
      const missed = await this.loadMessagesAfter(attachment.chatId, after);
      safeSend(ws, {
        type: "replay",
        chatId: attachment.chatId,
        after,
        messages: missed,
      });
      return;
    }

    if (type === "read") {
      const requestedSeq = frame["seq"];
      if (
        requestedSeq !== undefined &&
        (typeof requestedSeq !== "number" || !Number.isInteger(requestedSeq) || requestedSeq < 0)
      ) {
        safeSend(ws, { type: "error", code: "invalid_seq", message: "seq must be a non-negative integer." });
        return;
      }
      const updated = await this.enqueueWrite(() =>
        this.markReadInD1(attachment.chatId, attachment.userId, requestedSeq),
      );
      this.broadcastReadEvent(attachment.chatId, attachment.userId, updated.lastReadSeq);
      return;
    }

    if (type === "send") {
      const body = typeof frame["body"] === "string" ? frame["body"] : "";
      const clientMessageId =
        typeof frame["clientMessageId"] === "string" ? frame["clientMessageId"] : "";
      const outcome = await this.enqueueWrite(() =>
        this.persistAndBroadcastMessage(attachment.chatId, attachment.userId, clientMessageId, body, ws),
      );
      if (!outcome.ok) {
        safeSend(ws, {
          type: "error",
          code: outcome.code,
          message: outcome.error,
          clientMessageId,
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        });
        return;
      }
      safeSend(ws, {
        type: "ack",
        clientMessageId: outcome.message.clientMessageId,
        message: outcome.message,
      });
      return;
    }

    safeSend(ws, { type: "error", code: "unknown_type", message: "Unsupported frame type." });
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Socket may already be closed.
    }
    await this.scheduleNextExpiryAlarm();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "Socket error");
    } catch {
      // Socket may already be closed.
    }
    await this.scheduleNextExpiryAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    let earliestExp: number | null = null;

    for (const ws of sockets) {
      const attachment = readAttachment(ws);
      if (attachment === null || attachment.exp <= now) {
        try {
          ws.close(CHAT_CLOSE_AUTH_EXPIRED, "Session expired");
        } catch {
          // Ignore already-closed sockets.
        }
        continue;
      }
      if (earliestExp === null || attachment.exp < earliestExp) {
        earliestExp = attachment.exp;
      }
    }

    if (earliestExp !== null) {
      await this.ctx.storage.setAlarm(earliestExp);
    }
  }

  private async scheduleNextExpiryAlarm(): Promise<void> {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    let earliestExp: number | null = null;

    for (const ws of sockets) {
      const attachment = readAttachment(ws);
      if (attachment === null) continue;
      const target = Math.max(now + 1, attachment.exp);
      if (earliestExp === null || target < earliestExp) {
        earliestExp = target;
      }
    }

    if (earliestExp !== null) {
      await this.ctx.storage.setAlarm(earliestExp);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async loadMessagesAfter(
    chatId: string,
    afterSeq: number,
  ): Promise<ReadonlyArray<PersistedChatMessage>> {
    const result = await this.env.DB.prepare(
      `SELECT id, chat_id, seq, sender_id, client_message_id, body, created_at
         FROM chat_messages
        WHERE chat_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`,
    )
      .bind(chatId, afterSeq, MAX_REPLAY_LIMIT)
      .all<StoredMessageRow>();
    return (result.results ?? []).map(mapMessageRow);
  }

  private async consumeRateLimit(
    senderId: string,
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number }> {
    const { max, windowMs } = this.rateLimitConfig();
    const now = Date.now();
    const key = rateKey(senderId);
    const stored = await this.ctx.storage.get<RateBucket>(key);

    const refillRatePerMs = max / windowMs;
    const currentTokens =
      stored === undefined
        ? max
        : Math.min(max, stored.tokens + Math.max(0, now - stored.updatedAt) * refillRatePerMs);

    if (currentTokens < 1) {
      const needed = 1 - currentTokens;
      const retryAfterMs = Math.max(100, Math.ceil(needed / refillRatePerMs));
      return { allowed: false, retryAfterMs };
    }

    await this.ctx.storage.put(key, {
      tokens: currentTokens - 1,
      updatedAt: now,
    } satisfies RateBucket);

    return { allowed: true };
  }

  private async allocateNextSeq(chatId: string): Promise<number> {
    let current = await this.ctx.storage.get<number>(STORAGE_LAST_SEQ);
    if (current === undefined) {
      const row = await this.env.DB.prepare(
        `SELECT MAX(seq) AS max_seq
           FROM (
             SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_messages WHERE chat_id = ?
             UNION ALL
             SELECT COALESCE(last_seq, 0) AS seq FROM chats WHERE id = ?
           )`,
      )
        .bind(chatId, chatId)
        .first<{ max_seq: number | null }>();
      current = Number(row?.max_seq ?? 0);
    }
    const next = current + 1;
    await this.ctx.storage.put(STORAGE_LAST_SEQ, next);
    return next;
  }

  private async findByClientMessageId(
    chatId: string,
    clientMessageId: string,
  ): Promise<PersistedChatMessage | null> {
    const existing = await this.env.DB.prepare(
      `SELECT id, chat_id, seq, sender_id, client_message_id, body, created_at
         FROM chat_messages
        WHERE chat_id = ? AND client_message_id = ?`,
    )
      .bind(chatId, clientMessageId)
      .first<StoredMessageRow>();
    return existing ? mapMessageRow(existing) : null;
  }

  private async persistAndBroadcastMessage(
    chatId: string,
    senderId: string,
    rawClientMessageId: string,
    rawBody: string,
    originSocket: WebSocket | undefined,
  ): Promise<PersistOutcome> {
    const trimmedBody = rawBody.trim();
    if (trimmedBody.length === 0 || trimmedBody.length > MAX_BODY_LENGTH) {
      return {
        ok: false,
        status: 400,
        code: "invalid_body",
        error: `Message body must be between 1 and ${MAX_BODY_LENGTH} characters.`,
      };
    }

    const trimmedClientId = rawClientMessageId.trim();
    if (trimmedClientId.length === 0 || trimmedClientId.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
      return {
        ok: false,
        status: 400,
        code: "invalid_client_message_id",
        error: `clientMessageId must be between 1 and ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters.`,
      };
    }

    // Idempotent retry lookup happens before rate-limit consumption and seq
    // allocation so replaying an already-persisted message never wastes a seq.
    const existing = await this.findByClientMessageId(chatId, trimmedClientId);
    if (existing !== null) {
      if (existing.senderId !== senderId) {
        return {
          ok: false,
          status: 409,
          code: "client_message_id_conflict",
          error: "That clientMessageId already belongs to another message.",
        };
      }
      return { ok: true, message: existing, deduplicated: true };
    }

    const limit = await this.consumeRateLimit(senderId);
    if (!limit.allowed) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        error: "You are sending messages too quickly. Please wait a moment.",
        retryAfterMs: limit.retryAfterMs,
      };
    }

    const seq = await this.allocateNextSeq(chatId);
    const now = Date.now();

    try {
      const results = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO chat_messages (chat_id, seq, sender_id, client_message_id, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING id, chat_id, seq, sender_id, client_message_id, body, created_at`,
        ).bind(chatId, seq, senderId, trimmedClientId, trimmedBody, now),
        this.env.DB.prepare(
          `UPDATE chats
              SET last_seq = MAX(last_seq, ?),
                  last_message_body = ?,
                  last_message_sender_id = ?,
                  last_message_at = ?
            WHERE id = ?`,
        ).bind(seq, trimmedBody, senderId, now, chatId),
        this.env.DB.prepare(
          `UPDATE chat_participants
              SET last_seq = MAX(last_seq, ?),
                  last_message_at = MAX(last_message_at, ?),
                  last_read_seq = MAX(last_read_seq, ?),
                  unread_count = 0
            WHERE chat_id = ? AND user_id = ?`,
        ).bind(seq, now, seq, chatId, senderId),
        this.env.DB.prepare(
          `UPDATE chat_participants
              SET last_seq = MAX(last_seq, ?),
                  last_message_at = MAX(last_message_at, ?),
                  unread_count = unread_count + 1
            WHERE chat_id = ? AND user_id <> ?`,
        ).bind(seq, now, chatId, senderId),
      ]);

      const inserted = (results[0]?.results as ReadonlyArray<StoredMessageRow> | undefined)?.[0];
      if (!inserted) {
        return {
          ok: false,
          status: 500,
          code: "persist_failed",
          error: "Message could not be saved.",
        };
      }

      const persisted = mapMessageRow(inserted);

      // Broadcast only after the D1 batch commits.
      for (const socket of this.ctx.getWebSockets()) {
        if (socket === originSocket) continue;
        safeSend(socket, { type: "message", message: persisted });
      }

      return { ok: true, message: persisted, deduplicated: false };
    } catch {
      // Handle a rare concurrent retry that hit the UNIQUE(chat_id, client_message_id)
      // constraint before returning an error.
      const raced = await this.findByClientMessageId(chatId, trimmedClientId);
      if (raced !== null) {
        if (raced.senderId !== senderId) {
          return {
            ok: false,
            status: 409,
            code: "client_message_id_conflict",
            error: "That clientMessageId already belongs to another message.",
          };
        }
        return { ok: true, message: raced, deduplicated: true };
      }
      return {
        ok: false,
        status: 500,
        code: "persist_failed",
        error: "Message could not be saved.",
      };
    }
  }

  private async markReadInD1(
    chatId: string,
    userId: string,
    requestedSeq: number | undefined,
  ): Promise<{ readonly lastReadSeq: number; readonly unreadCount: number }> {
    const seqParam = requestedSeq ?? null;
    const updated = await this.env.DB.prepare(
      `UPDATE chat_participants
          SET last_read_seq = MAX(last_read_seq, MIN(COALESCE(?, last_seq), last_seq)),
              unread_count = (
                SELECT COUNT(*)
                  FROM chat_messages
                 WHERE chat_id = chat_participants.chat_id
                   AND seq > MAX(
                         chat_participants.last_read_seq,
                         MIN(COALESCE(?, chat_participants.last_seq), chat_participants.last_seq)
                       )
                   AND sender_id <> chat_participants.user_id
              )
        WHERE chat_id = ? AND user_id = ?
       RETURNING last_read_seq, unread_count`,
    )
      .bind(seqParam, seqParam, chatId, userId)
      .first<{ last_read_seq: number; unread_count: number }>();

    if (!updated) {
      return { lastReadSeq: 0, unreadCount: 0 };
    }

    return {
      lastReadSeq: Number(updated.last_read_seq),
      unreadCount: Number(updated.unread_count),
    };
  }

  private broadcastReadEvent(chatId: string, userId: string, lastReadSeq: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      safeSend(socket, {
        type: "read",
        chatId,
        userId,
        lastReadSeq,
      });
    }
  }
}
