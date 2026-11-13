// Live end-to-end run for the chat socket.
//
// Drives a real dev server (a real Worker and a real `Chat` Durable Object over
// local D1) the way two browsers would: it registers two accounts, publishes a
// listing, starts a chat from the listing's contact form, opens sockets for both
// sides, sends from one and reads on the other, drops and reconnects one side,
// and posts without a socket to prove that path takes the next sequence number.
// It also proves the refusals: a stranger, a signed-out client, a cross-site form,
// and a plain GET against the socket path.
//
// Prerequisites: the local D1 migrations are applied and the dev server is
// running on BASE_URL (scripts/test.sh does both). Exits non-zero on failure.
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8794";
const ORIGIN = new URL(BASE_URL).origin;

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
  }
};

const request = async (path, init = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
};

const cookieOf = (response) => {
  const header = response.headers.getSetCookie().find((value) => value.startsWith("access_token="));
  if (header === undefined) throw new Error("the response set no access_token cookie");
  return header.split(";")[0];
};

const accountId = (cookie) => {
  const token = cookie.slice("access_token=".length);
  return String(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).id);
};

const register = async (label) => {
  const email = `chat-e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const response = await request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "chat-e2e" },
    body: JSON.stringify({ email, password: "correct horse battery staple" }),
  });
  if (response.status !== 200)
    throw new Error(`register ${label}: ${response.status} ${response.text}`);
  const cookie = cookieOf(response);
  return { cookie, id: accountId(cookie), email };
};

const json = (cookie) => ({
  "content-type": "application/json",
  "user-agent": "chat-e2e",
  cookie,
});

const form = (cookie, fields, origin = ORIGIN) => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "chat-e2e",
    origin,
    cookie,
  },
  body: new URLSearchParams(fields).toString(),
});

const createListing = async (owner, title) => {
  const created = await request("/api/listings", {
    method: "POST",
    headers: json(owner.cookie),
    body: JSON.stringify({
      kind: "room",
      title,
      description: "A room for the chat end-to-end run",
      priceMinor: 133_700,
      regionCode: "attica",
      sizeSqm: 28,
      furnished: 1,
      pets: 1,
    }),
  });
  if (created.status !== 200) throw new Error(`create listing: ${created.status} ${created.text}`);
  const id = created.json.id;
  const published = await request(`/api/listings/${id}/publish`, {
    method: "POST",
    headers: json(owner.cookie),
  });
  if (published.status !== 200) throw new Error(`publish listing: ${published.status}`);
  return id;
};

const startChat = async (seeker, listingId, body) => {
  const response = await request(
    "/chats/start",
    form(seeker.cookie, { listingId: String(listingId), body }),
  );
  if (response.status !== 303) throw new Error(`start chat: ${response.status} ${response.text}`);
  const location = response.headers.get("location") ?? "";
  const id = Number(location.split("/").pop());
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`start chat location: ${location}`);
  return id;
};

/*
 * A socket attempt that is expected to be refused. A dev server answers a refused
 * upgrade by dropping the connection rather than by completing a 101, so the
 * browser-visible fact is "the socket did not open"; the exact status behind that
 * refusal is asserted in `test/api/chat-socket.test.ts`.
 */
const socketRefused = (cookie, chatId) =>
  new Promise((resolve) => {
    const url = `${BASE_URL.replace("http://", "ws://")}/api/chats/${chatId}/socket?after=0`;
    const socket = new WebSocket(url, cookie === undefined ? {} : { headers: { cookie } });
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // The runtime may already have closed it.
      }
      resolve(value);
    };
    socket.addEventListener("open", () => settle("opened"));
    socket.addEventListener("error", () => settle("refused"));
    setTimeout(() => settle("timeout"), 5_000);
  });

/*
 * A live socket and the frames it has received. `waitFor` polls until a frame
 * matches, so a check reads as "the owner sees the message" rather than as a
 * sleep of a guessed length.
 */
const openSocket = async (cookie, chatId, after) => {
  const url = `${BASE_URL.replace("http://", "ws://")}/api/chats/${chatId}/socket?after=${after}`;
  const socket = new WebSocket(url, { headers: { cookie } });
  const frames = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data));
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`socket ${url} failed`)), {
      once: true,
    });
    setTimeout(() => reject(new Error(`socket ${url} timed out`)), 5_000);
  });
  return {
    socket,
    frames,
    close: () => socket.close(),
    send: (frame) => socket.send(JSON.stringify(frame)),
  };
};

const waitFor = async (frames, predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
    await sleep(20);
  }
};

const messages = (frame) =>
  frame.filter((value) => value.type === "message").map((value) => value.message);

const main = async () => {
  const owner = await register("owner");
  const seeker = await register("seeker");
  const stranger = await register("stranger");
  const listingId = await createListing(owner, `Chat e2e listing ${Date.now()}`);
  const contact = `Is this room free? ${Date.now()}`;
  const chatId = await startChat(seeker, listingId, contact);

  console.log(`chat ${chatId} on listing ${listingId}`);
  check("the contact form opened a chat and redirected to it", chatId > 0);

  // The owner's socket replays the contact message, which is the first message
  // of the chat rather than a parallel enquiry thread.
  const ownerSocket = await openSocket(owner.cookie, chatId, 0);
  const replayed = await waitFor(ownerSocket.frames, (frame) => frame.type === "message");
  check(
    "the owner's socket replays the contact message as seq 1",
    replayed.message.seq === 1 && replayed.message.body === contact,
    JSON.stringify(replayed),
  );
  check(
    "the replayed message was sent by the seeker",
    replayed.message.senderId === seeker.id,
    replayed.message.senderId,
  );

  // A live send from the other account.
  const seekerSocket = await openSocket(seeker.cookie, chatId, 1);
  seekerSocket.send({ type: "send", clientMessageId: `live-${Date.now()}`, body: "Live hello" });
  const ownerSawLive = await waitFor(
    ownerSocket.frames,
    (frame) => frame.type === "message" && frame.message.body === "Live hello",
  );
  const seekerSawLive = await waitFor(
    seekerSocket.frames,
    (frame) => frame.type === "message" && frame.message.body === "Live hello",
  );
  check(
    "a live message reaches the other account and the sender, as the next sequence number",
    ownerSawLive.message.seq === 2 && seekerSawLive.message.seq === 2,
    `${ownerSawLive.message.seq}/${seekerSawLive.message.seq}`,
  );

  // Identity is the ticket's, never the frame's.
  seekerSocket.send({
    type: "send",
    clientMessageId: `spoof-${Date.now()}`,
    body: "I claim to be the owner",
    senderId: owner.id,
  });
  const spoofed = await waitFor(
    ownerSocket.frames,
    (frame) => frame.type === "message" && frame.message.body === "I claim to be the owner",
  );
  check(
    "a frame cannot name its sender: the stored sender is the ticket's account",
    spoofed.message.senderId === seeker.id,
    spoofed.message.senderId,
  );

  // A rate limit answered to the sender, not to the room.
  for (let index = 0; index < 25; index += 1) {
    seekerSocket.send({
      type: "send",
      clientMessageId: `flood-${index}-${Date.now()}`,
      body: `flood ${index}`,
    });
  }
  const limited = await waitFor(
    seekerSocket.frames,
    (frame) => frame.type === "error",
    5_000,
  ).catch(() => undefined);
  check(
    "a sender past the rate limit is told so",
    limited !== undefined && limited.code === "rate_limited",
    JSON.stringify(limited),
  );

  // Drop one side, then take the gap cursor from the archive once that side's
  // pending frames have settled. The owner's socket is a different connection,
  // so its frames are not a happens-before for what the archive contains.
  seekerSocket.close();
  await sleep(100);
  const beforeDrop = await request(`/api/chats/${chatId}/messages`, {
    headers: json(seeker.cookie),
  });
  const lastBeforeDrop = beforeDrop.json.lastSeq;

  ownerSocket.send({
    type: "send",
    clientMessageId: `after-drop-1-${Date.now()}`,
    body: "While you were away (1)",
  });
  ownerSocket.send({
    type: "send",
    clientMessageId: `after-drop-2-${Date.now()}`,
    body: "While you were away (2)",
  });
  await waitFor(
    ownerSocket.frames,
    (frame) => frame.type === "message" && frame.message.body === "While you were away (2)",
  );

  const reconnect = await openSocket(seeker.cookie, chatId, lastBeforeDrop);
  await waitFor(
    reconnect.frames,
    (frame) => frame.type === "message" && frame.message.body === "While you were away (2)",
  );
  const replayedSeqs = messages(reconnect.frames).map((message) => message.seq);
  check(
    "a reconnect replays only the messages after the sequence number it names",
    replayedSeqs.every((seq) => seq > lastBeforeDrop) && replayedSeqs.length === 2,
    JSON.stringify(replayedSeqs),
  );

  // The no-socket fallback goes through the same object, so it takes the next
  // number and is fanned out to the socket that is already open.
  const lastSeq = Math.max(...messages(ownerSocket.frames).map((message) => message.seq));
  const posted = await request(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: json(owner.cookie),
    body: JSON.stringify({
      body: "Posted without a socket",
      clientMessageId: `post-${Date.now()}`,
    }),
  });
  check(
    "posting without a socket answers with the next sequence number",
    posted.status === 200 && posted.json.seq === lastSeq + 1,
    `${posted.status} ${posted.text}`,
  );
  const seenLive = await waitFor(
    reconnect.frames,
    (frame) => frame.type === "message" && frame.message.body === "Posted without a socket",
  );
  check(
    "the no-socket post is fanned out to an open socket at the same number",
    seenLive.message.seq === lastSeq + 1,
    String(seenLive.message.seq),
  );

  const ordered = await request(`/api/chats/${chatId}/messages`, { headers: json(seeker.cookie) });
  const seqs = ordered.json.items.map((item) => item.seq);
  check(
    "the archive reads back in one strictly increasing order",
    seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]),
    JSON.stringify(seqs),
  );

  const newestPage = await request(
    `/api/chats/${chatId}/messages?before=${ordered.json.lastSeq + 1}&limit=10`,
    { headers: json(seeker.cookie) },
  );
  const newestSeqs = newestPage.json.items.map((item) => item.seq);
  check(
    "a before page returns the newest history in order",
    newestPage.status === 200 &&
      newestSeqs.every((seq, index) => index === 0 || seq > newestSeqs[index - 1]) &&
      newestSeqs.at(-1) === ordered.json.lastSeq &&
      newestPage.json.hasEarlier === true,
    `${newestPage.status} ${JSON.stringify(newestPage.json)}`,
  );

  const earlierPage = await request(
    `/api/chats/${chatId}/messages?before=${newestSeqs[0]}&limit=1`,
    { headers: json(seeker.cookie) },
  );
  const earlierSeqs = earlierPage.json.items.map((item) => item.seq);
  check(
    "the next before page starts exactly one sequence below the loaded page",
    earlierPage.status === 200 &&
      earlierSeqs.length === 1 &&
      earlierSeqs[0] === newestSeqs[0] - 1 &&
      earlierSeqs.every((seq) => !newestSeqs.includes(seq)),
    `${earlierPage.status} ${JSON.stringify(earlierPage.json)}`,
  );

  // Unread is D1's answer: the owner's messages above the seeker's read mark.
  const seekerInbox = await request("/api/chats", { headers: json(seeker.cookie) });
  const seekerRow = seekerInbox.json.items.find((item) => item.id === chatId);
  const ownerMessages = ordered.json.items.filter((item) => item.senderId === owner.id).length;
  check(
    "the inbox counts the other side's messages as unread",
    seekerRow !== undefined && seekerRow.unreadCount === ownerMessages,
    `${seekerRow?.unreadCount} vs ${ownerMessages}`,
  );

  const acknowledged = await request(`/api/chats/${chatId}/read`, {
    method: "POST",
    headers: json(seeker.cookie),
    body: JSON.stringify({ seq: ordered.json.lastSeq }),
  });
  check("a read acknowledgement is accepted", acknowledged.status === 200, acknowledged.text);
  const acknowledgedInbox = await request("/api/chats", { headers: json(seeker.cookie) });
  check(
    "a read acknowledgement clears the unread count without reopening the thread",
    acknowledgedInbox.json.items.find((item) => item.id === chatId)?.unreadCount === 0,
  );

  await request(`/api/chats/${chatId}`, { headers: json(seeker.cookie) });
  const cleared = await request("/api/chats", { headers: json(seeker.cookie) });
  check(
    "opening the chat clears its unread count",
    cleared.json.items.find((item) => item.id === chatId)?.unreadCount === 0,
  );

  const ownerInbox = await request("/api/chats", { headers: json(owner.cookie) });
  check(
    "the listing's owner sees the same chat in their inbox",
    ownerInbox.json.items.some((item) => item.id === chatId),
  );

  // The pages the reader lands on.
  const listPage = await request("/chats", {
    headers: { cookie: seeker.cookie, "user-agent": "chat-e2e" },
  });
  check(
    "the chat list page renders the chat",
    listPage.status === 200 && listPage.text.includes(`/chats/${chatId}`),
  );
  const threadPage = await request(`/chats/${chatId}`, {
    headers: { cookie: seeker.cookie, "user-agent": "chat-e2e" },
  });
  check(
    "the thread page renders the messages, the send box and the socket data",
    threadPage.status === 200 &&
      threadPage.text.includes("Posted without a socket") &&
      threadPage.text.includes(`action="/chats/${chatId}/messages"`) &&
      threadPage.text.includes(`data-chat-id="${chatId}"`),
  );

  // A loaded earlier page must not make the socket replay that page again.
  await waitFor(
    ownerSocket.frames,
    (frame) => frame.type === "message" && frame.message.body === "Posted without a socket",
  );
  const beforePagingSend = ownerSocket.frames.length;
  const pagingBody = `paging-${Date.now()}`;
  ownerSocket.send({
    type: "send",
    clientMessageId: `paging-${Date.now()}`,
    body: pagingBody,
  });
  await waitFor(
    ownerSocket.frames,
    (frame) => frame.type === "message" && frame.message.body === pagingBody,
  );
  const pagingSeqs = messages(ownerSocket.frames.slice(beforePagingSend)).map(
    (message) => message.seq,
  );
  check(
    "the socket delivers exactly one new frame and none from the loaded page",
    pagingSeqs.length === 1 &&
      pagingSeqs[0] === ordered.json.lastSeq + 1 &&
      earlierSeqs.every((seq) => !pagingSeqs.includes(seq)),
    JSON.stringify(pagingSeqs),
  );

  // The refusals.
  const strangerAttempt = await socketRefused(stranger.cookie, chatId);
  check("a non-participant's socket is refused", strangerAttempt === "refused", strangerAttempt);
  const anonymousAttempt = await socketRefused(undefined, chatId);
  check("a signed-out socket is refused", anonymousAttempt === "refused", anonymousAttempt);
  const plainGet = await request(`/api/chats/${chatId}/socket`, { headers: json(seeker.cookie) });
  check(
    "a plain GET of the socket path asks for an upgrade",
    plainGet.status === 426,
    String(plainGet.status),
  );

  const crossSite = await request(
    "/chats/start",
    form(
      seeker.cookie,
      { listingId: String(listingId), body: "cross-site" },
      "https://evil.example",
    ),
  );
  check(
    "a cross-site contact form is refused with 403",
    crossSite.status === 403,
    String(crossSite.status),
  );

  const ownListing = await request(
    "/chats/start",
    form(owner.cookie, { listingId: String(listingId), body: "talking to myself" }),
  );
  check(
    "an owner cannot start a chat about their own listing",
    ownListing.status === 400 && ownListing.text.includes("your own listing"),
    String(ownListing.status),
  );

  ownerSocket.close();
  reconnect.close();
  await sleep(100);
};

try {
  await main();
} catch (error) {
  failures += 1;
  console.error("chat socket e2e failed:", error);
}

if (failures > 0) {
  console.log(`chat socket e2e: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("chat socket e2e: all checks passed");
process.exit(0);
