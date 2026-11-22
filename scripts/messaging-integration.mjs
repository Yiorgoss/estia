// Live end-to-end WebSocket + Durable Object messaging integration test.
//
// Runs against the real Vite/Cloudflare dev server (`BASE_URL`, real `workerd`
// `Chat` Durable Object, real local D1). Opens real WebSocket connections using
// Node's global `WebSocket` (with HttpOnly session cookies via undici headers),
// sends messages from one account, verifies live delivery on the other, tests
// no-socket POST ordering parity, tests reconnect catch-up by `seq`, tests
// unread count clearing on read, verifies non-participant / unauthenticated
// rejection, and tests refresh-token rotation during WebSocket upgrade.

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8794";
const WS_BASE_URL = BASE_URL.replace(/^http/, "ws");

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) {
    console.log(`  ok   ${label}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
  }
};

const parseSetCookies = (response) => {
  const cookies = {};
  const list = response.headers.getSetCookie?.() ?? [];
  for (const header of list) {
    const [pair = ""] = header.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return cookies;
};

const userIdFromJwt = (token) => {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return String(payload.id);
};

const registerAccount = async (label) => {
  const email = `chat-e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "estia-chat-e2e" },
    body: JSON.stringify({ email, password: "correct horse battery staple" }),
  });
  if (res.status !== 200) {
    throw new Error(`register ${label} failed: ${res.status} ${await res.text()}`);
  }
  const cookies = parseSetCookies(res);
  return {
    email,
    id: userIdFromJwt(cookies.access_token),
    accessToken: cookies.access_token,
    refreshToken: cookies.refresh_token,
    cookieHeader: `access_token=${cookies.access_token}; refresh_token=${cookies.refresh_token}`,
  };
};

class SocketClient {
  constructor(url, headers = {}) {
    this.url = url;
    this.headers = headers;
    this.frames = [];
    this.waiters = [];
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: this.headers });
      this.ws = ws;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Timed out opening WebSocket ${this.url}`));
        }
      }, 10_000);

      ws.addEventListener("open", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
        }
      });

      ws.addEventListener("error", (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket failed to open ${this.url}: ${event?.message ?? "error"}`));
        }
      });

      ws.addEventListener("message", (event) => {
        let parsed;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        for (let i = 0; i < this.waiters.length; i += 1) {
          const waiter = this.waiters[i];
          if (waiter.predicate(parsed)) {
            this.waiters.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(parsed);
            return;
          }
        }
        this.frames.push(parsed);
      });
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(predicate, label, timeoutMs = 8000) {
    const existingIdx = this.frames.findIndex(predicate);
    if (existingIdx >= 0) {
      return Promise.resolve(this.frames.splice(existingIdx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for frame: ${label}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2000);
      this.ws.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.close(1000, "test done");
    });
  }
}

const main = async () => {
  console.log(`messaging live integration against ${BASE_URL}`);

  const lister = await registerAccount("lister");
  const seeker = await registerAccount("seeker");
  const intruder = await registerAccount("intruder");

  // 1. Lister creates and publishes a listing.
  const createRes = await fetch(`${BASE_URL}/api/listings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: lister.cookieHeader,
    },
    body: JSON.stringify({
      kind: "room",
      title: `Live Chat Listing ${Date.now()}`,
      description: "Testing live chat over Durable Objects",
      priceMinor: 75_000,
      regionCode: "attica",
      sizeSqm: 28,
    }),
  });
  check("lister creates listing", createRes.status === 200, `status=${createRes.status}`);
  const listing = await createRes.json();

  const pubRes = await fetch(`${BASE_URL}/api/listings/${listing.id}/publish`, {
    method: "POST",
    headers: { cookie: lister.cookieHeader },
  });
  check("lister publishes listing", pubRes.status === 200, `status=${pubRes.status}`);

  // 2. Listing detail page shows "Message lister" CTA; submitting it opens the chat.
  const detailBefore = await fetch(`${BASE_URL}/listings/${listing.id}`, {
    headers: { cookie: seeker.cookieHeader },
  });
  const detailBeforeHtml = await detailBefore.text();
  check(
    "listing detail shows Message lister CTA",
    detailBefore.status === 200 &&
      detailBeforeHtml.includes(`action="/listings/${listing.id}/chat"`),
  );

  const openPageRes = await fetch(`${BASE_URL}/listings/${listing.id}/chat`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      cookie: seeker.cookieHeader,
    },
    body: "",
  });
  const location = openPageRes.headers.get("location") ?? "";
  check(
    "listing detail CTA redirects to /chats/:id",
    openPageRes.status === 303 && /^\/chats\/[a-f0-9]+$/.test(location),
    location,
  );
  const chatId = location.replace("/chats/", "");

  // 3. Signed-out GET /chats renders sign-in prompt, not bare 401 text.
  const signedOutChats = await fetch(`${BASE_URL}/chats`);
  const signedOutHtml = await signedOutChats.text();
  check(
    "signed-out GET /chats renders HTML sign-in prompt",
    signedOutChats.status === 401 &&
      signedOutHtml.includes("Sign in required") &&
      !signedOutHtml.includes("UnauthorizedError"),
  );

  // 4. Auth boundaries: unauthenticated -> 401, non-participant -> 403.
  const unauthSocketRes = await fetch(`${BASE_URL}/api/chats/${chatId}/socket`);
  check("unauthenticated socket route answers 401", unauthSocketRes.status === 401);

  const intruderSocketRes = await fetch(`${BASE_URL}/api/chats/${chatId}/socket`, {
    headers: { cookie: intruder.cookieHeader },
  });
  check("non-participant socket route answers 403", intruderSocketRes.status === 403);

  const intruderMsgsRes = await fetch(`${BASE_URL}/api/chats/${chatId}/messages`, {
    headers: { cookie: intruder.cookieHeader },
  });
  check("non-participant GET /api/chats/:id/messages answers 403", intruderMsgsRes.status === 403);

  // 5. Open live WebSockets for both participants (with tampered ?userId= on seeker).
  const seekerWs = new SocketClient(
    `${WS_BASE_URL}/api/chats/${chatId}/socket?userId=${encodeURIComponent(intruder.id)}`,
    { cookie: seeker.cookieHeader },
  );
  const listerWs = new SocketClient(`${WS_BASE_URL}/api/chats/${chatId}/socket`, {
    cookie: lister.cookieHeader,
  });

  try {
    await seekerWs.connect();
    const seekerConnected = await seekerWs.waitFor(
      (f) => f.type === "connected",
      "seeker connected",
    );
    check(
      "seeker socket ignores tampered ?userId= and uses session identity",
      seekerConnected.userId === seeker.id && seekerConnected.chatId === chatId,
      JSON.stringify(seekerConnected),
    );

    await listerWs.connect();
    const listerConnected = await listerWs.waitFor(
      (f) => f.type === "connected",
      "lister connected",
    );
    check("lister socket connected", listerConnected.userId === lister.id);

    seekerWs.send({ type: "ping" });
    const pong = await seekerWs.waitFor((f) => f.type === "pong", "pong");
    check("ping/pong reports 2 active connections", pong.connections === 2, JSON.stringify(pong));

    // 6. Seeker sends 2 messages over WebSocket; lister receives seq 1, 2 live.
    seekerWs.send({
      type: "send",
      clientMessageId: "live-1",
      body: "Hello from seeker #1",
      senderId: intruder.id,
    });
    const ack1 = await seekerWs.waitFor(
      (f) => f.type === "ack" && f.clientMessageId === "live-1",
      "ack 1",
    );
    const live1 = await listerWs.waitFor(
      (f) => f.type === "message" && f.message?.seq === 1,
      "lister live 1",
    );
    check(
      "live message 1 delivered with seq=1 and verified senderId",
      ack1.message?.seq === 1 &&
        live1.message?.senderId === seeker.id &&
        live1.message?.body === "Hello from seeker #1",
    );

    seekerWs.send({ type: "send", clientMessageId: "live-2", body: "Hello from seeker #2" });
    await seekerWs.waitFor((f) => f.type === "ack" && f.clientMessageId === "live-2", "ack 2");
    const live2 = await listerWs.waitFor(
      (f) => f.type === "message" && f.message?.seq === 2,
      "lister live 2",
    );
    check("live message 2 delivered with seq=2", live2.message?.seq === 2);

    // 7. No-socket HTTP POST fallback produces seq=3 and fans out to live WebSocket.
    const postFallbackRes = await fetch(`${BASE_URL}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: lister.cookieHeader,
      },
      body: JSON.stringify({ clientMessageId: "live-3", body: "Reply via HTTP POST" }),
    });
    const postMsg = await postFallbackRes.json();
    const live3OnSeeker = await seekerWs.waitFor(
      (f) => f.type === "message" && f.message?.seq === 3,
      "seeker live 3 from POST",
    );
    check(
      "no-socket POST allocates seq=3 and pushes to live socket",
      postFallbackRes.status === 200 &&
        postMsg.seq === 3 &&
        live3OnSeeker.message?.body === "Reply via HTTP POST",
    );

    // 8. Lister disconnects; seeker sends seq 4 & 5 + replays live-4 idempotently.
    await listerWs.close();

    seekerWs.send({ type: "send", clientMessageId: "live-4", body: "Offline message #4" });
    await seekerWs.waitFor((f) => f.type === "ack" && f.clientMessageId === "live-4", "ack 4");
    seekerWs.send({ type: "send", clientMessageId: "live-5", body: "Offline message #5" });
    await seekerWs.waitFor((f) => f.type === "ack" && f.clientMessageId === "live-5", "ack 5");
    // Replay live-4 -> idempotent ack with seq 4.
    seekerWs.send({ type: "send", clientMessageId: "live-4", body: "Offline message #4" });
    const dupAck = await seekerWs.waitFor(
      (f) => f.type === "ack" && f.clientMessageId === "live-4",
      "duplicate ack 4",
    );
    check("replaying clientMessageId live-4 keeps seq=4", dupAck.message?.seq === 4);

    // 9. Lister inbox shows unreadCount=2 from D1 (for messages 4 and 5 after lister's own seq 3)
    //    and returns participants[] with both members and their roles.
    const inboxBeforeRes = await fetch(`${BASE_URL}/api/chats`, {
      headers: { cookie: lister.cookieHeader },
    });
    const inboxBefore = await inboxBeforeRes.json();
    const listerChat = inboxBefore.items.find((item) => item.id === chatId);
    const participants = Array.isArray(listerChat?.participants) ? listerChat.participants : [];
    const hasBothParticipants =
      participants.length === 2 &&
      participants.some((p) => p.userId === seeker.id && p.role === "seeker") &&
      participants.some((p) => p.userId === lister.id && p.role === "lister");
    check(
      "lister inbox shows unreadCount=2 and participants[] before reconnect",
      inboxBeforeRes.status === 200 && listerChat?.unreadCount === 2 && hasBothParticipants,
      JSON.stringify(listerChat),
    );

    // 10. Lister reconnects with ?after=3 (and tests refresh_token rotation by omitting access_token!).
    const listerReconnectWs = new SocketClient(
      `${WS_BASE_URL}/api/chats/${chatId}/socket?after=3`,
      { cookie: `refresh_token=${lister.refreshToken}` },
    );
    try {
      await listerReconnectWs.connect();
      const replay = await listerReconnectWs.waitFor(
        (f) => f.type === "replay",
        "reconnect replay",
      );
      const seqs = (replay.messages ?? []).map((m) => m.seq);
      check(
        "reconnect with ?after=3 over refresh_token replays seq [4, 5] only",
        JSON.stringify(seqs) === "[4,5]",
        JSON.stringify(seqs),
      );

      // Lister sends read event -> clears unread in D1 and notifies seeker's live socket.
      listerReconnectWs.send({ type: "read", seq: 5 });
      const readOnSeeker = await seekerWs.waitFor(
        (f) => f.type === "read" && f.userId === lister.id && f.lastReadSeq === 5,
        "read broadcast on seeker",
      );
      check("seeker's live socket receives lister's read event", readOnSeeker.lastReadSeq === 5);

      const inboxAfterRes = await fetch(`${BASE_URL}/api/chats`, {
        headers: { cookie: lister.cookieHeader },
      });
      const inboxAfter = await inboxAfterRes.json();
      const cleared = inboxAfter.items.find((item) => item.id === chatId);
      check("lister unreadCount cleared to 0 after read", cleared?.unreadCount === 0);
    } finally {
      await listerReconnectWs.close();
    }
  } finally {
    await seekerWs.close();
    await listerWs.close();
  }

  console.log(
    failures === 0
      ? "MESSAGING LIVE INTEGRATION PASSED"
      : `MESSAGING LIVE INTEGRATION FAILED (${failures})`,
  );
};

main().then(
  () => process.exit(failures === 0 ? 0 : 1),
  (error) => {
    console.error("messaging integration error", error);
    process.exit(2);
  },
);
