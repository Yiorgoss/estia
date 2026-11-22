import { Chat, type ChatDurableObjectEnv } from "@/durable-objects/chat";
import { Effect, String as Str } from "effect";
import type { SqlClient } from "effect/sql";

/*
 * In-memory Cloudflare Durable Object + Hibernatable WebSocket + D1 test harness.
 *
 * Runs the real `Chat` Durable Object class from `src/durable-objects/chat.ts`
 * directly against the in-memory SQLite database from `test/support/sql.ts`,
 * including full support for `acceptWebSocket`, `serializeAttachment`, alarms,
 * and simulated hibernation (reconstructing `new Chat(state, env)` while
 * keeping storage and accepted sockets alive).
 */

export class MockWebSocket {
  public readyState = 1; // OPEN
  public closedCode: number | undefined;
  public closedReason: string | undefined;
  public readonly sent: Array<string> = [];
  private attachment: unknown = null;
  private peer: MockWebSocket | null = null;
  private onMessageHandler: ((data: string) => void) | null = null;
  private onCloseHandler: ((code: number, reason: string) => void) | null = null;

  static createPair(): readonly [MockWebSocket, MockWebSocket] {
    const client = new MockWebSocket();
    const server = new MockWebSocket();
    client.peer = server;
    server.peer = client;
    return [client, server];
  }

  setHandlers(handlers: {
    readonly onMessage?: (data: string) => void;
    readonly onClose?: (code: number, reason: string) => void;
  }): void {
    this.onMessageHandler = handlers.onMessage ?? null;
    this.onCloseHandler = handlers.onClose ?? null;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    const text = typeof data === "string" ? data : new TextDecoder().decode(new Uint8Array(data));
    if (this.peer !== null) {
      this.peer.sent.push(text);
      this.peer.onMessageHandler?.(text);
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.closedCode = code;
    this.closedReason = reason;
    if (this.peer !== null && this.peer.readyState !== 3) {
      this.peer.readyState = 3;
      this.peer.closedCode = code;
      this.peer.closedReason = reason;
      this.peer.onCloseHandler?.(code, reason);
    }
  }

  serializeAttachment(value: unknown): void {
    // Round-trip through JSON to match Cloudflare's structured clone / 16 KB limit.
    const json = JSON.stringify(value);
    if (json.length > 16 * 1024) {
      throw new Error("Attachment exceeds 16 KB limit");
    }
    this.attachment = JSON.parse(json);
  }

  deserializeAttachment(): unknown {
    return this.attachment === null ? null : JSON.parse(JSON.stringify(this.attachment));
  }

  // Test helper: read all frames received on this side as parsed JSON objects.
  receivedJson(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

export const installMockWebSocketPair = (): void => {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  if (globalRecord["WebSocketPair"] !== undefined) return;
  class MockWebSocketPair {
    readonly 0: MockWebSocket;
    readonly 1: MockWebSocket;
    constructor() {
      const [client, server] = MockWebSocket.createPair();
      this[0] = client;
      this[1] = server;
    }
  }
  globalRecord["WebSocketPair"] = MockWebSocketPair;
};

const toSnakeRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[Str.camelToSnake(key)] = value;
  }
  return out;
};

/*
 * Wraps the shared Effect `SqlClient` (`TestSqlLive`) as a Cloudflare
 * `D1Database` so the real `Chat` Durable Object executes its exact D1
 * `prepare().bind().first/all/run` and `batch()` SQL against the same database
 * that the repositories and API handlers read. `TestSqlLive` transforms result
 * keys to camelCase, so we transform them back to snake_case here to match the
 * real Cloudflare D1 driver.
 */
export const createD1Adapter = (
  runSql: <T extends object = Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<unknown>,
  ) => Promise<ReadonlyArray<T>>,
): D1Database => {
  interface BoundStatement {
    readonly sql: string;
    readonly params: ReadonlyArray<unknown>;
    bind: (...values: ReadonlyArray<unknown>) => BoundStatement;
    first: <T = Record<string, unknown>>() => Promise<T | null>;
    all: <T = Record<string, unknown>>() => Promise<{ results: Array<T>; success: boolean }>;
    run: () => Promise<{ results: Array<unknown>; success: boolean }>;
  }

  const makeStatement = (sql: string, params: ReadonlyArray<unknown> = []): BoundStatement => ({
    sql,
    params,
    bind: (...values) => makeStatement(sql, values),
    first: async <T = Record<string, unknown>>() => {
      const rows = await runSql<Record<string, unknown>>(sql, params);
      return rows[0] === undefined ? null : (toSnakeRow(rows[0]) as T);
    },
    all: async <T = Record<string, unknown>>() => {
      const rows = await runSql<Record<string, unknown>>(sql, params);
      return { results: rows.map(toSnakeRow) as unknown as Array<T>, success: true };
    },
    run: async () => {
      const rows = await runSql<Record<string, unknown>>(sql, params);
      return { results: rows.map(toSnakeRow) as unknown as Array<unknown>, success: true };
    },
  });

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: ReadonlyArray<BoundStatement>) => {
      const outputs: Array<{ results: Array<unknown>; success: boolean }> = [];
      for (const stmt of statements) {
        const rows = await runSql<Record<string, unknown>>(stmt.sql, stmt.params);
        outputs.push({ results: rows.map(toSnakeRow) as unknown as Array<unknown>, success: true });
      }
      return outputs;
    },
  } as unknown as D1Database;
};

export interface MockChatState {
  readonly state: DurableObjectState;
  readonly storageMap: Map<string, unknown>;
  readonly getAlarm: () => number | null;
  readonly getAcceptedSockets: () => ReadonlyArray<MockWebSocket>;
}

export const createMockDurableObjectState = (idName: string): MockChatState => {
  const storageMap = new Map<string, unknown>();
  const sockets = new Map<MockWebSocket, ReadonlyArray<string>>();
  let alarmTime: number | null = null;

  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => {
      const value = storageMap.get(key);
      return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
    },
    put: async (key: string, value: unknown): Promise<void> => {
      storageMap.set(key, JSON.parse(JSON.stringify(value)));
    },
    delete: async (key: string): Promise<boolean> => storageMap.delete(key),
    setAlarm: async (scheduledTime: number | Date): Promise<void> => {
      alarmTime = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    },
    getAlarm: async (): Promise<number | null> => alarmTime,
    deleteAlarm: async (): Promise<void> => {
      alarmTime = null;
    },
  };

  const state = {
    id: {
      toString: () => idName,
      equals: (other: { toString(): string }) => other.toString() === idName,
      name: idName,
    },
    storage,
    acceptWebSocket: (ws: WebSocket, tags: ReadonlyArray<string> = []) => {
      const mock = ws as unknown as MockWebSocket;
      sockets.set(mock, [...tags]);
    },
    getWebSockets: (tag?: string): Array<WebSocket> => {
      const active: Array<WebSocket> = [];
      for (const [ws, tags] of sockets.entries()) {
        if (ws.readyState !== 1) continue;
        if (tag === undefined || tags.includes(tag)) {
          active.push(ws as unknown as WebSocket);
        }
      }
      return active;
    },
  } as unknown as DurableObjectState;

  return {
    state,
    storageMap,
    getAlarm: () => alarmTime,
    getAcceptedSockets: () => Array.from(sockets.keys()).filter((ws) => ws.readyState === 1),
  };
};

export interface MockChatNamespaceHandle {
  readonly namespace: DurableObjectNamespace;
  readonly getInstance: (chatId: string) => {
    readonly chat: Chat;
    readonly mockState: MockChatState;
  };
  // Simulates Cloudflare Durable Object hibernation: drops the in-memory `Chat`
  // instance while preserving `ctx.storage` and all accepted sockets, so the
  // next request/message/alarm constructs a brand new `Chat` instance.
  readonly hibernate: (chatId: string) => void;
  readonly sendClientMessage: (
    chatId: string,
    clientSocket: MockWebSocket,
    payload: unknown,
  ) => Promise<void>;
  readonly closeClientSocket: (
    chatId: string,
    clientSocket: MockWebSocket,
    code?: number,
    reason?: string,
  ) => Promise<void>;
  readonly fireAlarm: (chatId: string) => Promise<void>;
  readonly resetAll: () => void;
}

export const createMockChatNamespace = (
  envFactory: () => ChatDurableObjectEnv,
): MockChatNamespaceHandle => {
  installMockWebSocketPair();

  const states = new Map<string, MockChatState>();
  const instances = new Map<string, Chat>();
  const clientToServer = new WeakMap<MockWebSocket, MockWebSocket>();

  const getOrCreate = (name: string) => {
    let mockState = states.get(name);
    if (mockState === undefined) {
      mockState = createMockDurableObjectState(name);
      states.set(name, mockState);
    }
    let chat = instances.get(name);
    if (chat === undefined) {
      chat = new Chat(mockState.state, envFactory());
      instances.set(name, chat);
    }
    return { chat, mockState };
  };

  const namespace = {
    idFromName: (name: string) => ({
      toString: () => name,
      name,
      equals: (other: { toString(): string }) => other.toString() === name,
    }),
    get: (id: { toString(): string }) => {
      const name = id.toString();
      return {
        id,
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = input instanceof Request ? input : new Request(input, init);
          const { chat, mockState } = getOrCreate(name);
          const beforeSockets = new Set(mockState.getAcceptedSockets());
          const response = await chat.fetch(request);

          // In Node, `new Response(null, { status: 101 })` is forbidden by the
          // Fetch spec, so our MockResponse path below handles 101 upgrades.
          const afterSockets = mockState.getAcceptedSockets();
          const newServer = afterSockets.find((s) => !beforeSockets.has(s));
          const client = (response as unknown as { webSocket?: MockWebSocket }).webSocket;
          if (client !== undefined && newServer !== undefined) {
            clientToServer.set(client, newServer);
          }
          return response;
        },
      };
    },
  } as unknown as DurableObjectNamespace;

  return {
    namespace,
    getInstance: getOrCreate,
    hibernate: (chatId: string) => {
      instances.delete(chatId);
    },
    sendClientMessage: async (chatId: string, clientSocket: MockWebSocket, payload: unknown) => {
      const server = clientToServer.get(clientSocket);
      if (server === undefined) {
        throw new Error("Unknown client socket for chat");
      }
      const { chat } = getOrCreate(chatId);
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      await chat.webSocketMessage(server as unknown as WebSocket, raw);
    },
    closeClientSocket: async (
      chatId: string,
      clientSocket: MockWebSocket,
      code = 1000,
      reason = "Normal Closure",
    ) => {
      const server = clientToServer.get(clientSocket);
      clientSocket.close(code, reason);
      if (server !== undefined) {
        const { chat } = getOrCreate(chatId);
        await chat.webSocketClose(server as unknown as WebSocket, code, reason, true);
      }
    },
    fireAlarm: async (chatId: string) => {
      const { chat } = getOrCreate(chatId);
      await chat.alarm();
    },
    resetAll: () => {
      states.clear();
      instances.clear();
    },
  };
};

// Patch Node's `Response` constructor in tests ONLY when `status === 101` with
// a `webSocket` property (which Cloudflare's workerd `Response` supports and
// standard Node/undici `Response` rejects with RangeError).
export const installWorkerd101ResponseShim = (): void => {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  if (globalRecord["__estia101ResponsePatched"] === true) return;
  const NativeResponse = globalThis.Response;
  const PatchedResponse = function (
    body?: BodyInit | null,
    init?: ResponseInit & { readonly webSocket?: unknown },
  ) {
    if (init !== undefined && init.status === 101) {
      const headers = new Headers(init.headers);
      return {
        status: 101,
        statusText: "Switching Protocols",
        ok: false,
        headers,
        body: null,
        webSocket: init.webSocket,
        text: async () => "",
        json: async () => null,
      } as unknown as Response;
    }
    return new NativeResponse(body, init);
  } as unknown as typeof Response;
  PatchedResponse.prototype = NativeResponse.prototype;
  Object.setPrototypeOf(PatchedResponse, NativeResponse);
  globalThis.Response = PatchedResponse;
  globalRecord["__estia101ResponsePatched"] = true;
};

export const runEffectSql =
  (sqlClient: SqlClient.SqlClient) =>
  <T extends object = Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<unknown>,
  ): Promise<ReadonlyArray<T>> =>
    Effect.runPromise(sqlClient.unsafe<T>(statement, params).pipe(Effect.orDie));
