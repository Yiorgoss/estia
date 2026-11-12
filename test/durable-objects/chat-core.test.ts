import {
  CHAT_POLICY_CLOSE_CODE,
  CHAT_REPLAY_LIMIT,
  CHAT_SESSION_CLOSE_CODE,
  createChatCore,
  type ChatCore,
  type ChatMessageRow,
  type ChatMessageStore,
  type ChatObjectContext,
  type ChatSocket,
} from "@/durable-objects/chat-core";
import {
  signChatTicket,
  verifyChatTicket,
  CHAT_TICKET_HEADER,
} from "@/durable-objects/chat-ticket";
import { assert, describe, it } from "@effect/vitest";

/*
 * The chat object's behaviour, driven without a workerd runtime.
 *
 * The object is the only allocator of a chat's sequence numbers, so these tests
 * are about the guarantees that make it worth having: a total order per chat, one
 * row per client id, a replay from a sequence number, a per-sender rate limit, a
 * ticket that decides identity, and a wake that continues where it left off
 * instead of starting over.
 */

const SECRET = "chat-core-test-secret-chat-core-test-secret";
const CHAT_ID = 7;
const START = 1_700_000_000_000;

interface FakeSocket extends ChatSocket {
  readonly frames: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly closed: ReadonlyArray<{
    readonly code: number | undefined;
    readonly reason: string | undefined;
  }>;
  readonly raw: Array<string>;
}

const fakeSocket = (): FakeSocket => {
  const raw: Array<string> = [];
  const closed: Array<{ code: number | undefined; reason: string | undefined }> = [];
  let attachment: unknown = null;
  return {
    raw,
    closed,
    get frames() {
      return raw.map((value) => JSON.parse(value) as Readonly<Record<string, unknown>>);
    },
    send: (message) => {
      raw.push(message);
    },
    close: (code, reason) => {
      closed.push({ code, reason });
    },
    serializeAttachment: (value) => {
      attachment = value;
    },
    deserializeAttachment: () => attachment,
  };
};

const fakeStore = (holdListAfter?: () => Promise<void>) => {
  const rows: Array<ChatMessageRow> = [];
  let nextId = 1;
  const store: ChatMessageStore & { readonly rows: ReadonlyArray<ChatMessageRow> } = {
    rows,
    append: async (values) => {
      const existing = rows.find(
        (row) =>
          row.chatId === values.chatId &&
          row.senderId === values.senderId &&
          row.clientMessageId === values.clientMessageId,
      );
      if (existing !== undefined) return { _tag: "duplicate", message: existing };
      const row: ChatMessageRow = { id: nextId, ...values };
      nextId += 1;
      rows.push(row);
      return { _tag: "stored", message: row };
    },
    listAfter: async (chatId, afterSeq, limit) => {
      const snapshot = rows
        .filter((row) => row.chatId === chatId && row.seq > afterSeq)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit);
      if (holdListAfter !== undefined) await holdListAfter();
      return snapshot;
    },
  };
  return store;
};

const makeChat = (
  options: {
    readonly rateLimit?: { windowMs: number; maxMessages: number };
    readonly holdListAfter?: () => Promise<void>;
  } = {},
) => {
  const values = new Map<string, unknown>();
  const sockets: Array<FakeSocket> = [];
  const alarms: Array<number> = [];
  const store = fakeStore(options.holdListAfter);
  let now = START;

  const ctx: ChatObjectContext = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (entries) => {
        for (const [key, value] of Object.entries(entries)) values.set(key, value);
      },
    },
    getWebSockets: () => sockets,
    setAlarm: async (scheduledTime) => {
      alarms.push(scheduledTime);
    },
  };

  const makeCore = () =>
    createChatCore(ctx, store, {
      chatId: CHAT_ID,
      clock: () => now,
      verifyTicket: (raw) => verifyChatTicket(SECRET, raw, now),
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    });

  return {
    core: makeCore(),
    wake: makeCore,
    storage: values,
    store,
    sockets,
    alarms,
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/*
 * A connection: the socket is registered the way `acceptWebSocket` registers it,
 * then the object's own accept path serializes the identity the ticket proved and
 * replays anything newer than `after`.
 */
const connect = async (chat: ReturnType<typeof makeChat>, userId: string, after = 0) => {
  const socket = fakeSocket();
  chat.sockets.push(socket);
  const now = chat.clock();
  await chat.core.accept(
    socket,
    { userId, chatId: CHAT_ID, exp: now + 60_000, sessionExp: now + 3_600_000 },
    after,
  );
  return socket;
};

const send = (core: ChatCore, socket: FakeSocket, body: string, clientMessageId: string) =>
  core.receive(socket, JSON.stringify({ type: "send", clientMessageId, body }));

const messageSeqs = (socket: FakeSocket) =>
  socket.frames
    .filter((frame) => frame["type"] === "message")
    .map((frame) => (frame["message"] as { seq: number }).seq);

describe("chat core ordering and fan-out", () => {
  it("allocates one sequence number per send and fans the row out in order", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");
    const bob = await connect(chat, "user-b");

    await send(chat.core, alice, "hello", "a-1");
    await send(chat.core, alice, "still there?", "a-2");
    await send(chat.core, bob, "yes", "b-1");

    assert.deepEqual(
      chat.store.rows.map((row) => [row.seq, row.body]),
      [
        [1, "hello"],
        [2, "still there?"],
        [3, "yes"],
      ],
    );
    assert.deepEqual(messageSeqs(alice), [1, 2, 3]);
    assert.deepEqual(messageSeqs(bob), [1, 2, 3]);
  });

  it("takes the sender from the ticket, never from the frame", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");

    await chat.core.receive(
      alice,
      JSON.stringify({
        type: "send",
        clientMessageId: "a-1",
        body: "I am bob, honest",
        senderId: "user-b",
      }),
    );

    assert.strictEqual(chat.store.rows[0]?.senderId, "user-a");
  });

  it("writes one row for a repeated client id and does not broadcast it twice", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");
    const bob = await connect(chat, "user-b");

    await send(chat.core, alice, "retry me", "same-id");
    await send(chat.core, alice, "retry me", "same-id");

    assert.strictEqual(chat.store.rows.length, 1);
    assert.deepEqual(messageSeqs(bob), [1]);
    assert.deepEqual(messageSeqs(alice), [1]);
  });

  it("rejects a blank message and an unknown frame with an error for that socket only", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");
    const bob = await connect(chat, "user-b");

    await send(chat.core, alice, "   ", "a-1");
    await chat.core.receive(alice, JSON.stringify({ type: "shout", body: "hi" }));
    await chat.core.receive(alice, "not json");

    assert.strictEqual(chat.store.rows.length, 0);
    assert.deepEqual(
      alice.frames.map((frame) => frame["code"]),
      ["invalid_message", "bad_frame", "bad_frame"],
    );
    assert.deepEqual(bob.frames, []);
  });

  it("stores the same client id from the other sender as its own message", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");
    const bob = await connect(chat, "user-b");

    await send(chat.core, alice, "from alice", "same-id");
    await send(chat.core, bob, "from bob", "same-id");

    assert.deepEqual(
      chat.store.rows.map((row) => [row.senderId, row.body]),
      [
        ["user-a", "from alice"],
        ["user-b", "from bob"],
      ],
    );
    assert.deepEqual(messageSeqs(bob), [1, 2]);
  });
});

describe("chat core replay", () => {
  it("replays only the messages after the sequence number a reconnecting socket names", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");

    await send(chat.core, alice, "one", "a-1");
    await send(chat.core, alice, "two", "a-2");
    await send(chat.core, alice, "three", "a-3");

    const bob = await connect(chat, "user-b", 2);
    assert.deepEqual(messageSeqs(bob), [3]);

    const carol = await connect(chat, "user-c", 0);
    assert.deepEqual(messageSeqs(carol), [1, 2, 3]);

    const upToDate = await connect(chat, "user-d", 3);
    assert.deepEqual(messageSeqs(upToDate), []);
  });

  it("replays the whole gap when it is longer than one page", async () => {
    const chat = makeChat({ rateLimit: { windowMs: 10_000, maxMessages: 200 } });
    const ticket = {
      userId: "user-a",
      chatId: CHAT_ID,
      exp: START + 60_000,
      sessionExp: START + 3_600_000,
    };
    const total = CHAT_REPLAY_LIMIT + 5;
    for (let index = 1; index <= total; index += 1) {
      await chat.core.append(ticket, {
        clientMessageId: `a-${index}`,
        body: `message ${index}`,
      });
    }

    const bob = await connect(chat, "user-b", 0);
    const seqs = messageSeqs(bob);

    assert.strictEqual(seqs.length, total);
    assert.strictEqual(seqs.at(0), 1);
    assert.strictEqual(seqs.at(-1), total);
  });

  it("holds live frames until a socket's replay has finished", async () => {
    let snapshotTaken: () => void = () => undefined;
    const snapshot = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chat = makeChat({
      holdListAfter: async () => {
        snapshotTaken();
        await gate;
      },
    });

    await chat.core.append(
      { userId: "user-a", chatId: CHAT_ID, exp: START + 60_000, sessionExp: START + 3_600_000 },
      { clientMessageId: "a-1", body: "before" },
    );

    const socket = fakeSocket();
    chat.sockets.push(socket);
    const accepting = chat.core.accept(
      socket,
      {
        userId: "user-a",
        chatId: CHAT_ID,
        exp: START + 60_000,
        sessionExp: START + 3_600_000,
      },
      0,
    );
    await snapshot;

    await chat.core.append(
      { userId: "user-b", chatId: CHAT_ID, exp: START + 60_000, sessionExp: START + 3_600_000 },
      { clientMessageId: "b-1", body: "during replay" },
    );
    release();
    await accepting;

    assert.deepEqual(messageSeqs(socket), [1, 2]);
  });

  it("answers a replay frame with the same page", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");
    await send(chat.core, alice, "one", "a-1");
    await send(chat.core, alice, "two", "a-2");

    const bob = await connect(chat, "user-b", 2);
    await chat.core.receive(bob, JSON.stringify({ type: "replay", after: 1 }));

    assert.deepEqual(messageSeqs(bob), [2]);
  });

  it("continues the sequence after a hibernation wake and still replays from D1", async () => {
    const chat = makeChat();
    const alice = await connect(chat, "user-a");
    await send(chat.core, alice, "before the wake", "a-1");

    // A wake builds a fresh object over the same storage and archive: nothing
    // in memory survives, and the sequence counter must come back from storage.
    const woken = chat.wake();
    const aliceAgain = fakeSocket();
    chat.sockets.push(aliceAgain);
    await woken.accept(
      aliceAgain,
      {
        userId: "user-a",
        chatId: CHAT_ID,
        exp: chat.clock() + 60_000,
        sessionExp: chat.clock() + 3_600_000,
      },
      0,
    );
    assert.deepEqual(messageSeqs(aliceAgain), [1]);

    await send(woken, aliceAgain, "after the wake", "a-2");
    assert.deepEqual(
      chat.store.rows.map((row) => row.seq),
      [1, 2],
    );

    const bob = fakeSocket();
    chat.sockets.push(bob);
    await woken.accept(
      bob,
      {
        userId: "user-b",
        chatId: CHAT_ID,
        exp: chat.clock() + 60_000,
        sessionExp: chat.clock() + 3_600_000,
      },
      1,
    );
    assert.deepEqual(messageSeqs(bob), [2]);

    assert.strictEqual(chat.storage.get("last_seq"), 2);
  });
});

describe("chat core rate limit", () => {
  it("refuses a sender past the window's allowance and allows it again once the window passes", async () => {
    const chat = makeChat({ rateLimit: { windowMs: 10_000, maxMessages: 2 } });
    const alice = await connect(chat, "user-a");
    const bob = await connect(chat, "user-b");

    await send(chat.core, alice, "one", "a-1");
    await send(chat.core, alice, "two", "a-2");
    await send(chat.core, alice, "three", "a-3");

    assert.strictEqual(chat.store.rows.length, 2);
    assert.deepEqual(
      alice.frames.filter((frame) => frame["type"] === "error").map((frame) => frame["code"]),
      ["rate_limited"],
    );
    // The limit is per sender: the other side is unaffected.
    await send(chat.core, bob, "still fine", "b-1");
    assert.strictEqual(chat.store.rows.length, 3);

    chat.advance(10_000);
    await send(chat.core, alice, "four", "a-4");
    assert.strictEqual(chat.store.rows.length, 4);
  });
});

describe("chat core ticket", () => {
  const authorise = async (chat: ReturnType<typeof makeChat>, ticket: string | undefined) => {
    const headers = new Headers();
    if (ticket !== undefined) headers.set(CHAT_TICKET_HEADER, ticket);
    return chat.core.authorise(new Request("https://chat.internal/connect?after=4", { headers }));
  };

  it("accepts a ticket the Worker signed and reads the replay point from the upgrade", async () => {
    const chat = makeChat();
    const ticket = await signChatTicket(SECRET, {
      userId: "user-a",
      chatId: CHAT_ID,
      exp: chat.clock() + 60_000,
      sessionExp: chat.clock() + 3_600_000,
    });

    const decision = await authorise(chat, ticket);
    assert.strictEqual(decision._tag, "accepted");
    if (decision._tag !== "accepted") return;
    assert.strictEqual(decision.ticket.userId, "user-a");
    assert.strictEqual(decision.after, 4);
  });

  it("refuses a missing, forged, or expired ticket", async () => {
    const chat = makeChat();
    const valid = await signChatTicket(SECRET, {
      userId: "user-a",
      chatId: CHAT_ID,
      exp: chat.clock() + 60_000,
      sessionExp: chat.clock() + 3_600_000,
    });
    const [payload, signature] = valid.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        u: "user-b",
        c: CHAT_ID,
        e: chat.clock() + 60_000,
        s: chat.clock() + 3_600_000,
      }),
    ).toString("base64url");
    const forged = `${forgedPayload}.${signature}`;
    const tamperedSignature = `${payload}.${signature?.slice(0, -2)}xx`;
    const expired = await signChatTicket(SECRET, {
      userId: "user-a",
      chatId: CHAT_ID,
      exp: chat.clock() - 1,
      sessionExp: chat.clock() + 3_600_000,
    });
    const signedWithAnotherSecret = await signChatTicket("another-secret-another-secret", {
      userId: "user-a",
      chatId: CHAT_ID,
      exp: chat.clock() + 60_000,
      sessionExp: chat.clock() + 3_600_000,
    });

    for (const ticket of [undefined, forged, tamperedSignature, expired, signedWithAnotherSecret]) {
      const decision = await authorise(chat, ticket);
      assert.strictEqual(decision._tag, "refused", `expected a refusal for ${String(ticket)}`);
      if (decision._tag !== "refused") continue;
      assert.strictEqual(decision.status, 401);
    }
  });

  it("refuses a valid ticket that names another chat", async () => {
    const chat = makeChat();
    const ticket = await signChatTicket(SECRET, {
      userId: "user-a",
      chatId: CHAT_ID + 1,
      exp: chat.clock() + 60_000,
      sessionExp: chat.clock() + 3_600_000,
    });

    const decision = await authorise(chat, ticket);
    assert.strictEqual(decision._tag, "refused");
    if (decision._tag !== "refused") return;
    assert.strictEqual(decision.status, 403);
  });
});

describe("chat core socket lifetime", () => {
  it("closes a socket that carried no identity attachment", async () => {
    const chat = makeChat();
    const socket = fakeSocket();
    chat.sockets.push(socket);

    await send(chat.core, socket, "no identity", "a-1");

    assert.deepEqual(socket.closed, [{ code: CHAT_POLICY_CLOSE_CODE, reason: "identity_missing" }]);
  });

  it("keeps a socket open after its handshake ticket expires", async () => {
    const chat = makeChat();
    const socket = fakeSocket();
    chat.sockets.push(socket);
    await chat.core.accept(
      socket,
      {
        userId: "user-a",
        chatId: CHAT_ID,
        exp: chat.clock() + 1_000,
        sessionExp: chat.clock() + 3_600_000,
      },
      0,
    );

    chat.advance(2_000);
    await send(chat.core, socket, "still here", "a-1");
    await chat.core.alarm();

    assert.strictEqual(chat.store.rows.length, 1);
    assert.deepEqual(socket.closed, []);
    assert.strictEqual(chat.alarms.at(-1), chat.clock() + 3_598_000);
  });

  it("closes a socket whose session has aged out instead of accepting its message", async () => {
    const chat = makeChat();
    const socket = fakeSocket();
    chat.sockets.push(socket);
    await chat.core.accept(
      socket,
      {
        userId: "user-a",
        chatId: CHAT_ID,
        exp: chat.clock() + 60_000,
        sessionExp: chat.clock() - 1,
      },
      0,
    );

    await send(chat.core, socket, "too late", "a-1");

    assert.strictEqual(chat.store.rows.length, 0);
    assert.deepEqual(socket.closed, [{ code: CHAT_SESSION_CLOSE_CODE, reason: "session_expired" }]);
  });

  it("arms the alarm for the earliest expiry and closes only the sockets that reached it", async () => {
    const chat = makeChat();
    const early = fakeSocket();
    const late = fakeSocket();
    chat.sockets.push(early, late);

    await chat.core.accept(
      early,
      {
        userId: "user-a",
        chatId: CHAT_ID,
        exp: chat.clock() + 60_000,
        sessionExp: chat.clock() + 1_000,
      },
      0,
    );
    await chat.core.accept(
      late,
      {
        userId: "user-b",
        chatId: CHAT_ID,
        exp: chat.clock() + 60_000,
        sessionExp: chat.clock() + 5_000,
      },
      0,
    );
    assert.strictEqual(chat.alarms.at(-1), chat.clock() + 1_000);

    chat.advance(1_500);
    await chat.core.alarm();

    assert.deepEqual(early.closed, [{ code: CHAT_SESSION_CLOSE_CODE, reason: "session_expired" }]);
    assert.deepEqual(late.closed, []);
    // The alarm that ran is spent; the next one is the remaining socket.
    assert.strictEqual(chat.alarms.at(-1), chat.clock() + 3_500);
  });
});
