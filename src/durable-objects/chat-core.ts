import { CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH, CHAT_MESSAGE_MAX_LENGTH } from "@/db/schema/Chat";
import { CHAT_TICKET_HEADER, type ChatTicket } from "@/durable-objects/chat-ticket";

/*
 * The chat object's behaviour, written against the smallest surface it needs
 * from the Durable Object runtime and from D1. The class in `./chat.ts` is the
 * thin part that owns the runtime pieces (`WebSocketPair`, the 101 response) and
 * the steps a test can drive without a workerd runtime - the ticket check, the
 * sequence allocation, the fan-out, the gap replay and the per-sender rate
 * limit - live here.
 *
 * It is the only writer of `chat_messages`. One object per chat means one
 * allocator of `seq`, so two sends can never receive the same number no matter
 * what order D1 observes. A gap (a number allocated but never written, because
 * the object went away between the two) is possible and is deliberately not
 * repaired: readers tolerate a missing number and nothing renumbers.
 *
 * Everything here is per-event and re-entrant: hibernation re-runs the
 * constructor and drops every in-memory field, so the sequence counter is loaded
 * lazily from storage and every socket's identity is read from its own
 * attachment. Nothing holds a socket in a map.
 */

export const CHAT_SEQ_STORAGE_KEY = "last_seq";

// The two paths the Worker forwards to the object. The object is internal, so
// these are not URL space the app exposes.
export const CHAT_CONNECT_PATH = "/connect";
export const CHAT_APPEND_PATH = "/append";

export const CHAT_SESSION_CLOSE_CODE = 4001;
export const CHAT_POLICY_CLOSE_CODE = 1008;

export const CHAT_RATE_LIMIT = { windowMs: 10_000, maxMessages: 20 } as const;

// A reconnect replays what it missed; it is a catch-up frame, not an export.
export const CHAT_REPLAY_LIMIT = 100;

export interface ChatMessageRow {
  readonly id: number;
  readonly chatId: number;
  readonly seq: number;
  readonly senderId: string;
  readonly body: string;
  readonly clientMessageId: string;
  readonly createdAt: number;
}

export interface AppendMessageValues {
  readonly chatId: number;
  readonly seq: number;
  readonly senderId: string;
  readonly body: string;
  readonly clientMessageId: string;
  readonly createdAt: number;
}

/*
 * The archive as the object sees it. `append` writes the message and moves the
 * chat's projection (`last_seq`, `last_message_at`) in one D1 batch, so the row
 * and the inbox's view of it cannot disagree; a client id the same sender already
 * holds comes back as `duplicate` instead of a second row.
 */
export interface ChatMessageStore {
  readonly append: (values: AppendMessageValues) => Promise<
    | { readonly _tag: "stored"; readonly message: ChatMessageRow }
    | {
        readonly _tag: "duplicate";
        readonly message: ChatMessageRow;
      }
  >;
  readonly listAfter: (
    chatId: number,
    afterSeq: number,
    limit: number,
  ) => Promise<ReadonlyArray<ChatMessageRow>>;
}

/*
 * The pieces of the runtime the behaviour calls. `getWebSockets` is the
 * hibernation API's own registry: it returns the sockets this object accepted,
 * with their attachments, whether or not this event woke the object.
 */
export interface ChatObjectContext {
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(entries: Record<string, unknown>): Promise<void>;
  };
  readonly getWebSockets: (tag?: string) => ReadonlyArray<ChatSocket>;
  readonly setAlarm: (scheduledTime: number) => Promise<void>;
}

/*
 * The slice of a WebSocket the behaviour uses. A real `WebSocket` satisfies it;
 * so does the small fake the unit tests drive.
 */
export interface ChatSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown;
}

export interface ChatSocketAttachment {
  readonly userId: string;
  readonly exp: number;
  readonly connectionId: string;
}

export type ChatClientFrame =
  | { readonly type: "send"; readonly clientMessageId: string; readonly body: string }
  | { readonly type: "replay"; readonly after: number };

export type ChatServerFrame =
  | { readonly type: "message"; readonly message: ChatMessageRow }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export type AppendResult =
  | {
      readonly _tag: "stored";
      readonly message: ChatMessageRow;
      /** The row this sender's client id already wrote, so nothing was broadcast again. */
      readonly duplicate: boolean;
    }
  | { readonly _tag: "invalid"; readonly reason: string }
  | { readonly _tag: "rate_limited" };

export type UpgradeDecision =
  | { readonly _tag: "accepted"; readonly ticket: ChatTicket; readonly after: number }
  | { readonly _tag: "refused"; readonly status: 401 | 403; readonly reason: string };

export interface AppendInput {
  readonly clientMessageId: string;
  readonly body: string;
}

export interface ChatCoreOptions {
  readonly chatId: number;
  readonly clock: () => number;
  /*
   * Ticket verification with the app's own secret. It is injected so the object
   * never needs the raw secret in this module, and a test can hand in a verifier
   * that is not the Worker's signing path.
   */
  readonly verifyTicket: (raw: string) => Promise<ChatTicket | undefined>;
  readonly rateLimit?: { readonly windowMs: number; readonly maxMessages: number };
}

export interface ChatCore {
  readonly authorise: (request: Request) => Promise<UpgradeDecision>;
  readonly accept: (socket: ChatSocket, ticket: ChatTicket, after: number) => Promise<void>;
  readonly append: (ticket: ChatTicket, input: AppendInput) => Promise<AppendResult>;
  readonly receive: (socket: ChatSocket, message: string | ArrayBuffer) => Promise<void>;
  readonly close: (socket: ChatSocket, code: number, reason: string) => void;
  readonly alarm: () => Promise<void>;
}

const textDecoder = new TextDecoder();

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const attachmentOf = (socket: ChatSocket): ChatSocketAttachment | undefined => {
  const value = asRecord(socket.deserializeAttachment());
  if (value === undefined) return undefined;
  const { userId, exp, connectionId } = value;
  if (typeof userId !== "string" || userId === "") return undefined;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  if (typeof connectionId !== "string" || connectionId === "") return undefined;
  return { userId, exp, connectionId };
};

/*
 * A frame is a small closed vocabulary, so an unrecognised shape is a refusal to
 * the one socket that sent it rather than a throw that would take the event down
 * and leave the sender guessing.
 */
export const parseClientFrame = (value: unknown): ChatClientFrame | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  switch (record["type"]) {
    case "replay": {
      const after = record["after"];
      if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) return undefined;
      return { type: "replay", after };
    }
    case "send": {
      const clientMessageId = record["clientMessageId"];
      const body = record["body"];
      if (typeof clientMessageId !== "string" || typeof body !== "string") return undefined;
      return { type: "send", clientMessageId, body };
    }
    default:
      return undefined;
  }
};

const parseAfter = (raw: string | null): number => {
  if (raw === null || !/^\d+$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const badFrame: ChatServerFrame = {
  type: "error",
  code: "bad_frame",
  message:
    'A frame is {"type":"send","clientMessageId":"...","body":"..."} or {"type":"replay","after":N}.',
};

export const createChatCore = (
  ctx: ChatObjectContext,
  store: ChatMessageStore,
  options: ChatCoreOptions,
): ChatCore => {
  if (!Number.isSafeInteger(options.chatId) || options.chatId <= 0) {
    throw new Error("A chat object must be addressed by a positive chat id");
  }

  const rateLimit = options.rateLimit ?? CHAT_RATE_LIMIT;

  /*
   * Sends are serialised inside the object. Two frames can interleave at the
   * first `await`, and the sequence allocator reads then writes storage: without
   * this, both frames could read the same counter and one would burn the other's
   * number. The queue is per isolate, and a hibernated object starts a fresh one,
   * which is safe because the counter it reads is the stored one.
   */
  let pending: Promise<unknown> = Promise.resolve();
  const serialise = <T>(task: () => Promise<T>): Promise<T> => {
    const run = pending.then(task, task);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let sequence: number | undefined;
  const loadSequence = async (): Promise<number> => {
    if (sequence === undefined) {
      sequence = (await ctx.storage.get<number>(CHAT_SEQ_STORAGE_KEY)) ?? 0;
    }
    return sequence;
  };

  const allocateSequence = async (): Promise<number> => {
    const next = (await loadSequence()) + 1;
    sequence = next;
    await ctx.storage.put({ [CHAT_SEQ_STORAGE_KEY]: next });
    return next;
  };

  const sendFrame = (socket: ChatSocket, frame: ChatServerFrame): void => {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A socket that is already gone is not a failed write: the message is
      // stored, and the reader picks it up from D1 on its next connection.
    }
  };

  /*
   * Live frames wait for a socket's replay to finish. A socket is registered with
   * the runtime before its history is read, and the read is an await that does not
   * hold the object's input gate: without this, a concurrent append could reach
   * the socket ahead of rows it is about to replay, and the reader's monotonic
   * cursor would then discard the replay.
   */
  const replayBuffers = new Map<string, Array<ChatServerFrame>>();

  const broadcast = (message: ChatMessageRow): void => {
    const frame: ChatServerFrame = { type: "message", message };
    for (const socket of ctx.getWebSockets()) {
      const connectionId = attachmentOf(socket)?.connectionId;
      const buffered = connectionId === undefined ? undefined : replayBuffers.get(connectionId);
      if (buffered !== undefined) buffered.push(frame);
      else sendFrame(socket, frame);
    }
  };

  const replay = async (socket: ChatSocket, after: number): Promise<void> => {
    let cursor = after;
    for (;;) {
      const rows = await store.listAfter(options.chatId, cursor, CHAT_REPLAY_LIMIT);
      for (const message of rows) sendFrame(socket, { type: "message", message });
      const last = rows.at(-1);
      if (rows.length < CHAT_REPLAY_LIMIT || last === undefined) return;
      cursor = last.seq;
    }
  };

  const replayInto = async (
    socket: ChatSocket,
    connectionId: string,
    after: number,
  ): Promise<void> => {
    const buffered: Array<ChatServerFrame> = [];
    replayBuffers.set(connectionId, buffered);
    try {
      await replay(socket, after);
      for (const frame of buffered) sendFrame(socket, frame);
    } finally {
      replayBuffers.delete(connectionId);
    }
  };

  /*
   * One alarm covers the whole object, so it is always the earliest expiry among
   * the live sockets. It closes sockets whose session has aged out; the client
   * reconnects and the Worker runs the refresh path again.
   */
  const scheduleAlarm = async (): Promise<void> => {
    const now = options.clock();
    let next: number | undefined;
    for (const socket of ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment === undefined || attachment.exp <= now) continue;
      next = next === undefined ? attachment.exp : Math.min(next, attachment.exp);
    }
    if (next !== undefined) await ctx.setAlarm(next);
  };

  const withinRateLimit = async (userId: string): Promise<boolean> => {
    const now = options.clock();
    const key = `rate:${userId}`;
    const state = await ctx.storage.get<{ readonly start: number; readonly count: number }>(key);
    const active =
      state !== undefined && now >= state.start && now - state.start < rateLimit.windowMs;
    const count = active && state !== undefined ? state.count : 0;
    if (count >= rateLimit.maxMessages) return false;
    await ctx.storage.put({
      [key]: { start: active && state !== undefined ? state.start : now, count: count + 1 },
    });
    return true;
  };

  const append = (ticket: ChatTicket, input: AppendInput): Promise<AppendResult> =>
    serialise(async () => {
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (body === "" || body.length > CHAT_MESSAGE_MAX_LENGTH) {
        return {
          _tag: "invalid",
          reason: `A message must be 1 to ${CHAT_MESSAGE_MAX_LENGTH} characters.`,
        };
      }
      const clientMessageId =
        typeof input.clientMessageId === "string" ? input.clientMessageId.trim() : "";
      if (clientMessageId === "" || clientMessageId.length > CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH) {
        return {
          _tag: "invalid",
          reason: `A client message id must be 1 to ${CHAT_CLIENT_MESSAGE_ID_MAX_LENGTH} characters.`,
        };
      }
      if (!(await withinRateLimit(ticket.userId))) return { _tag: "rate_limited" };

      const seq = await allocateSequence();
      const outcome = await store.append({
        chatId: options.chatId,
        seq,
        senderId: ticket.userId,
        body,
        clientMessageId,
        createdAt: options.clock(),
      });

      // Only a row that was actually written is news. A retried client id is
      // answered to the sender with the row it already has, and nobody else sees
      // the message twice.
      if (outcome._tag === "stored") broadcast(outcome.message);
      return {
        _tag: "stored",
        message: outcome.message,
        duplicate: outcome._tag === "duplicate",
      };
    });

  const receive = async (socket: ChatSocket, message: string | ArrayBuffer): Promise<void> => {
    const attachment = attachmentOf(socket);
    if (attachment === undefined) {
      socket.close(CHAT_POLICY_CLOSE_CODE, "identity_missing");
      return;
    }
    if (attachment.exp <= options.clock()) {
      socket.close(CHAT_SESSION_CLOSE_CODE, "session_expired");
      return;
    }

    const text = typeof message === "string" ? message : textDecoder.decode(message);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendFrame(socket, badFrame);
      return;
    }

    const frame = parseClientFrame(parsed);
    if (frame === undefined) {
      sendFrame(socket, badFrame);
      return;
    }

    if (frame.type === "replay") {
      await replayInto(socket, attachment.connectionId, frame.after);
      return;
    }

    const result = await append(
      {
        userId: attachment.userId,
        chatId: options.chatId,
        exp: attachment.exp,
        sessionExp: attachment.exp,
      },
      frame,
    );
    if (result._tag === "invalid") {
      sendFrame(socket, { type: "error", code: "invalid_message", message: result.reason });
    } else if (result._tag === "rate_limited") {
      sendFrame(socket, {
        type: "error",
        code: "rate_limited",
        message: `At most ${rateLimit.maxMessages} messages per ${Math.round(rateLimit.windowMs / 1000)} seconds.`,
      });
    }
  };

  const authorise = async (request: Request): Promise<UpgradeDecision> => {
    const raw = request.headers.get(CHAT_TICKET_HEADER);
    if (raw === null || raw === "") {
      return { _tag: "refused", status: 401, reason: "missing_ticket" };
    }
    const ticket = await options.verifyTicket(raw);
    if (ticket === undefined) {
      return { _tag: "refused", status: 401, reason: "invalid_ticket" };
    }
    if (ticket.chatId !== options.chatId) {
      return { _tag: "refused", status: 403, reason: "wrong_chat" };
    }
    return {
      _tag: "accepted",
      ticket,
      after: parseAfter(new URL(request.url).searchParams.get("after")),
    };
  };

  const accept = async (socket: ChatSocket, ticket: ChatTicket, after: number): Promise<void> => {
    const connectionId = crypto.randomUUID();
    socket.serializeAttachment({
      userId: ticket.userId,
      exp: ticket.sessionExp,
      connectionId,
    } satisfies ChatSocketAttachment);
    try {
      await replayInto(socket, connectionId, after);
    } finally {
      await scheduleAlarm();
    }
  };

  const close = (socket: ChatSocket, code: number, reason: string): void => {
    try {
      socket.close(code, reason);
    } catch {
      // Closing a socket the runtime has already closed is not an error.
    }
  };

  const alarm = async (): Promise<void> => {
    const now = options.clock();
    for (const socket of ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment === undefined || attachment.exp <= now) {
        close(socket, CHAT_SESSION_CLOSE_CODE, "session_expired");
      }
    }
    await scheduleAlarm();
  };

  return { authorise, accept, append, receive, close, alarm };
};
