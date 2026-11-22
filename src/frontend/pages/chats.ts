import type { ChatDetail, ChatMessage, ChatParticipant, ChatSummary } from "@/db/schema/Chat";
import {
  errorBanner,
  pageShell,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/frontend/layout";
import { regionLabels } from "@/frontend/listing-labels";
import { escapeHtml, formatPriceMinor } from "@/utils";

/*
 * Server-rendered chat pages: the inbox list (`/chats`) and a single chat
 * (`/chats/:id`).
 *
 * Both pages render from `chat.participants[]` rather than assuming a fixed
 * 2-person lister/seeker pair, so multi-participant chats and arbitrary role
 * names (such as `property_manager`, `roommate`, `agent`, or `support`) render
 * cleanly alongside 1-to-1 listing enquiries.
 *
 * The single-chat page renders the initial message history from D1 in `seq`
 * order, keeps a standard HTML form posting to `/chats/:id/messages` as the
 * no-socket fallback, and layers one small inline script on top for live
 * WebSocket delivery, gap catch-up on reconnect, and live read receipts.
 */

const formatTimestamp = (date: Date | null | undefined): string => {
  if (date == null) return "";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
};

export const formatChatRoleLabel = (role: string): string => {
  const trimmed = role.trim();
  if (trimmed === "lister") return "Lister";
  if (trimmed === "seeker") return "Seeker";
  const words = trimmed.split(/[_-\s]+/).filter((part) => part.length > 0);
  if (words.length === 0) return "Participant";
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase(),
    )
    .join(" ");
};

const visibleParticipants = (
  participants: ReadonlyArray<ChatParticipant>,
  currentUserId: string | undefined,
): ReadonlyArray<ChatParticipant> => {
  if (currentUserId === undefined) return participants;
  const others = participants.filter((p) => p.userId !== currentUserId);
  return others.length > 0 ? others : participants;
};

const participantTitle = (participants: ReadonlyArray<ChatParticipant>): string => {
  if (participants.length === 0) return "Chat";
  return participants.map((p) => p.displayName).join(", ");
};

const unreadBadge = (count: number): string =>
  count <= 0
    ? ""
    : `<span class="inline-flex min-w-6 items-center justify-center rounded-full bg-blue-700 px-2 py-0.5 text-xs font-semibold text-white" data-unread-badge>${count}</span>`;

const participantChips = (participants: ReadonlyArray<ChatParticipant>): string =>
  participants
    .map(
      (participant) =>
        `<span class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"><span>${escapeHtml(participant.displayName)}</span><span class="text-gray-500">(${escapeHtml(formatChatRoleLabel(participant.role))})</span></span>`,
    )
    .join("");

const inboxRow = (chat: ChatSummary, currentUserId: string | undefined): string => {
  const region = regionLabels[chat.listingRegionCode];
  const preview =
    chat.lastMessageBody != null && chat.lastMessageBody.trim() !== ""
      ? escapeHtml(chat.lastMessageBody)
      : "No messages yet — say hello.";
  const timestamp = formatTimestamp(chat.lastMessageAt ?? chat.createdAt);
  const peers = visibleParticipants(chat.participants, currentUserId);
  const heading = participantTitle(peers);

  const badges =
    peers.length === 1 && peers[0] !== undefined
      ? `<span class="text-sm font-semibold text-gray-900">${escapeHtml(peers[0].displayName)}</span>
         <span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">${escapeHtml(formatChatRoleLabel(peers[0].role))}</span>`
      : `<span class="text-sm font-semibold text-gray-900">${escapeHtml(heading)}</span>
         ${peers
           .map(
             (peer) =>
               `<span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">${escapeHtml(formatChatRoleLabel(peer.role))}</span>`,
           )
           .join("")}`;

  return `
    <li>
      <a
        href="/chats/${escapeHtml(chat.id)}"
        class="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/30"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              ${badges}
            </div>
            <p class="mt-0.5 truncate text-xs text-gray-500">
              ${escapeHtml(chat.listingTitle)} &middot; ${escapeHtml(region)} &middot; ${formatPriceMinor(chat.listingPriceMinor)}/mo
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            ${unreadBadge(chat.unreadCount)}
            <span class="text-xs text-gray-400">${escapeHtml(timestamp)}</span>
          </div>
        </div>
        <p class="mt-2 truncate text-sm ${chat.unreadCount > 0 ? "font-medium text-gray-900" : "text-gray-600"}">
          ${preview}
        </p>
      </a>
    </li>`;
};

export const chatsInboxPage = (state: {
  readonly items: ReadonlyArray<ChatSummary>;
  readonly totalUnread: number;
  readonly currentUserId?: string | undefined;
}): string => {
  const body =
    state.items.length === 0
      ? `
        <div class="mt-6 rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h2 class="text-base font-semibold text-gray-900">No chats yet</h2>
          <p class="mt-2 text-sm text-gray-600">
            Open any published listing and start a chat with the lister.
          </p>
          <p class="mt-4">
            <a href="/search" class="${primaryButtonClass} inline-block">Browse listings</a>
          </p>
        </div>`
      : `<ul class="mt-6 space-y-3" data-chat-list>${state.items
          .map((item) => inboxRow(item, state.currentUserId))
          .join("")}</ul>`;

  return pageShell(
    "Chats",
    `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Chats</h1>
        <p class="mt-1 text-sm text-gray-600">
          ${state.totalUnread > 0 ? `${state.totalUnread} unread message${state.totalUnread === 1 ? "" : "s"}` : "All caught up."}
        </p>
      </div>
      <a href="/search" class="${secondaryButtonClass}">Browse listings</a>
    </div>
    ${body}`,
  );
};

const messageItem = (
  message: ChatMessage,
  currentUserId: string,
  participantNames: ReadonlyMap<string, string>,
): string => {
  const mine = message.senderId === currentUserId;
  const senderLabel = mine ? "You" : (participantNames.get(message.senderId) ?? "Participant");
  const alignClass = mine
    ? "ml-auto bg-blue-700 text-white"
    : "mr-auto bg-white text-gray-900 border border-gray-200";
  const metaClass = mine ? "text-blue-100" : "text-gray-500";

  return `
    <li
      data-seq="${message.seq}"
      data-client-message-id="${escapeHtml(message.clientMessageId)}"
      data-sender-id="${escapeHtml(message.senderId)}"
      class="flex flex-col"
    >
      <div class="max-w-[85%] rounded-lg px-4 py-2.5 shadow-sm ${alignClass}">
        <div class="flex items-baseline justify-between gap-4 text-xs ${metaClass}">
          <span class="font-medium">${escapeHtml(senderLabel)}</span>
          <span>${escapeHtml(formatTimestamp(message.createdAt))}</span>
        </div>
        <p class="mt-1 whitespace-pre-wrap break-words text-sm">${escapeHtml(message.body)}</p>
      </div>
    </li>`;
};

const formatReadSummary = (
  participants: ReadonlyArray<ChatParticipant>,
  currentUserId: string,
): string =>
  participants
    .filter((p) => p.userId !== currentUserId && p.lastReadSeq > 0)
    .map((p) => `${p.displayName} read up to #${p.lastReadSeq}`)
    .join(" · ");

const safeInlineJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const chatClientScript = (config: {
  readonly chatId: string;
  readonly currentUserId: string;
  readonly participants: ReadonlyArray<{
    readonly userId: string;
    readonly displayName: string;
    readonly lastReadSeq: number;
  }>;
  readonly lastSeq: number;
}): string => `
<script>
(() => {
  const cfg = ${safeInlineJson(config)};
  const listEl = document.getElementById("chat-messages");
  const emptyEl = document.getElementById("chat-empty");
  const statusEl = document.getElementById("chat-status");
  const readEl = document.getElementById("chat-read-status");
  const errorEl = document.getElementById("chat-live-error");
  const formEl = document.getElementById("chat-send-form");
  const bodyEl = document.getElementById("chat-body");
  if (!listEl || !formEl || !bodyEl) return;

  let lastSeq = cfg.lastSeq;
  const participantsById = new Map();
  for (const p of cfg.participants) {
    participantsById.set(p.userId, { displayName: p.displayName, lastReadSeq: p.lastReadSeq });
  }
  let socket = null;
  let backoffMs = 1000;
  let reconnectTimer = null;
  let closing = false;
  const seenSeqs = new Set();
  const seenClientIds = new Set();

  for (const li of listEl.querySelectorAll("li[data-seq]")) {
    const s = Number(li.getAttribute("data-seq"));
    if (Number.isInteger(s) && s > 0) seenSeqs.add(s);
    const cid = li.getAttribute("data-client-message-id");
    if (cid) seenClientIds.add(cid);
  }

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const setError = (text) => {
    if (!errorEl) return;
    if (!text) {
      errorEl.textContent = "";
      errorEl.classList.add("hidden");
    } else {
      errorEl.textContent = text;
      errorEl.classList.remove("hidden");
    }
  };

  const updateReadLabel = () => {
    if (!readEl) return;
    const parts = [];
    for (const [uid, info] of participantsById.entries()) {
      if (uid !== cfg.currentUserId && info.lastReadSeq > 0) {
        parts.push(info.displayName + " read up to #" + info.lastReadSeq);
      }
    }
    if (parts.length > 0) {
      readEl.textContent = parts.join(" · ");
      readEl.classList.remove("hidden");
    }
  };

  const formatTime = (ms) => {
    try {
      return new Date(ms).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      });
    } catch {
      return "";
    }
  };

  const senderLabelFor = (senderId) => {
    if (senderId === cfg.currentUserId) return "You";
    const info = participantsById.get(senderId);
    return info ? info.displayName : "Participant";
  };

  const appendMessage = (msg) => {
    if (!msg || typeof msg.seq !== "number") return;
    if (seenSeqs.has(msg.seq) || (msg.clientMessageId && seenClientIds.has(msg.clientMessageId))) {
      return;
    }
    seenSeqs.add(msg.seq);
    if (msg.clientMessageId) seenClientIds.add(msg.clientMessageId);
    if (msg.seq > lastSeq) lastSeq = msg.seq;
    if (emptyEl) emptyEl.classList.add("hidden");

    const mine = msg.senderId === cfg.currentUserId;
    const li = document.createElement("li");
    li.setAttribute("data-seq", String(msg.seq));
    li.setAttribute("data-client-message-id", String(msg.clientMessageId || ""));
    li.setAttribute("data-sender-id", String(msg.senderId || ""));
    li.className = "flex flex-col";

    const bubble = document.createElement("div");
    bubble.className = "max-w-[85%] rounded-lg px-4 py-2.5 shadow-sm " +
      (mine ? "ml-auto bg-blue-700 text-white" : "mr-auto bg-white text-gray-900 border border-gray-200");

    const meta = document.createElement("div");
    meta.className = "flex items-baseline justify-between gap-4 text-xs " + (mine ? "text-blue-100" : "text-gray-500");
    const who = document.createElement("span");
    who.className = "font-medium";
    who.textContent = senderLabelFor(msg.senderId);
    const when = document.createElement("span");
    when.textContent = formatTime(msg.createdAt);
    meta.appendChild(who);
    meta.appendChild(when);

    const text = document.createElement("p");
    text.className = "mt-1 whitespace-pre-wrap break-words text-sm";
    text.textContent = String(msg.body || "");

    bubble.appendChild(meta);
    bubble.appendChild(text);
    li.appendChild(bubble);
    listEl.appendChild(li);
    listEl.scrollTop = listEl.scrollHeight;
  };

  const catchUpHttp = async () => {
    try {
      const res = await fetch("/api/chats/" + encodeURIComponent(cfg.chatId) + "/messages?after=" + lastSeq, {
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) appendMessage(msg);
      }
    } catch {
      // Fall through; the socket replay will also catch up.
    }
  };

  const connect = async () => {
    if (closing) return;
    setStatus("Connecting...");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = proto + "//" + location.host + "/api/chats/" + encodeURIComponent(cfg.chatId) + "/socket?after=" + lastSeq;
    const ws = new WebSocket(wsUrl);
    socket = ws;

    ws.addEventListener("open", () => {
      backoffMs = 1000;
      setStatus("Live");
      setError("");
    });

    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === "replay" && Array.isArray(frame.messages)) {
        for (const msg of frame.messages) appendMessage(msg);
        if (lastSeq > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "read", seq: lastSeq }));
        }
      } else if (frame.type === "message" && frame.message) {
        appendMessage(frame.message);
        if (frame.message.senderId !== cfg.currentUserId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "read", seq: frame.message.seq }));
        }
      } else if (frame.type === "ack" && frame.message) {
        appendMessage(frame.message);
      } else if (frame.type === "read") {
        if (frame.userId !== cfg.currentUserId && typeof frame.lastReadSeq === "number") {
          const existing = participantsById.get(frame.userId) || { displayName: "Participant", lastReadSeq: 0 };
          if (frame.lastReadSeq > existing.lastReadSeq) {
            existing.lastReadSeq = frame.lastReadSeq;
            participantsById.set(frame.userId, existing);
            updateReadLabel();
          }
        }
      } else if (frame.type === "error") {
        setError(frame.message || "Could not send message.");
      }
    });

    ws.addEventListener("close", (event) => {
      if (socket === ws) socket = null;
      if (closing) return;
      setStatus("Reconnecting...");
      const delay = event.code === 4001 ? 250 : backoffMs;
      backoffMs = Math.min(backoffMs * 2, 15000);
      reconnectTimer = setTimeout(async () => {
        await catchUpHttp();
        connect();
      }, delay);
    });
  };

  formEl.addEventListener("submit", (event) => {
    const text = bodyEl.value.trim();
    if (!text) {
      event.preventDefault();
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      event.preventDefault();
      setError("");
      const clientMessageId = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : "ws-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      socket.send(JSON.stringify({ type: "send", clientMessageId, body: text }));
      bodyEl.value = "";
      bodyEl.focus();
    }
  });

  window.addEventListener("beforeunload", () => {
    closing = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket) socket.close();
  });

  updateReadLabel();
  connect();
})();
</script>`;

export const chatDetailPage = (state: {
  readonly chat: ChatDetail;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly currentUserId: string;
  readonly error?: string | undefined;
}): string => {
  const region = regionLabels[state.chat.listingRegionCode];
  const lastSeq = state.messages[state.messages.length - 1]?.seq ?? 0;
  const peers = visibleParticipants(state.chat.participants, state.currentUserId);
  const title = participantTitle(peers);
  const participantNames = new Map<string, string>(
    state.chat.participants.map((p) => [p.userId, p.displayName]),
  );
  const readSummary = formatReadSummary(state.chat.participants, state.currentUserId);

  return pageShell(
    `Chat with ${title}`,
    `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <a href="/chats" class="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:text-blue-800">&larr; Back to chats</a>
      <span id="chat-status" class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">Connecting...</span>
    </div>

    <header class="mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 class="text-lg font-semibold text-gray-900">${escapeHtml(title)}</h1>
          <p class="mt-0.5 text-sm text-gray-600">
            <a href="/listings/${state.chat.listingId}" class="font-medium text-blue-700 hover:underline">${escapeHtml(state.chat.listingTitle)}</a>
            &middot; ${escapeHtml(region)} &middot; ${formatPriceMinor(state.chat.listingPriceMinor)}/mo
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5" data-chat-participants>
            ${participantChips(peers)}
          </div>
        </div>
        <p id="chat-read-status" class="${readSummary.length > 0 ? "" : "hidden "}text-xs text-gray-500">
          ${escapeHtml(readSummary)}
        </p>
      </div>
    </header>

    <div class="mt-4 space-y-2">
      ${errorBanner(state.error)}
      <p id="chat-live-error" class="hidden rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert"></p>
    </div>

    <section class="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 shadow-sm" aria-label="Messages">
      <p id="chat-empty" class="${state.messages.length === 0 ? "" : "hidden "}py-6 text-center text-sm text-gray-500">
        No messages yet. Send the first message below.
      </p>
      <ul id="chat-messages" class="max-h-[30rem] space-y-3 overflow-y-auto">
        ${state.messages.map((m) => messageItem(m, state.currentUserId, participantNames)).join("")}
      </ul>
    </section>

    <form
      id="chat-send-form"
      method="post"
      action="/chats/${escapeHtml(state.chat.id)}/messages"
      class="mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
    >
      <label for="chat-body" class="mb-1 block text-sm font-medium text-gray-700">Message</label>
      <textarea
        id="chat-body"
        name="body"
        rows="3"
        maxlength="2000"
        required
        placeholder="Write a message..."
        class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      ></textarea>
      <div class="mt-3 flex items-center justify-between gap-3">
        <p class="text-xs text-gray-500">
          Live delivery when connected; falls back to standard form submit if offline.
        </p>
        <button type="submit" class="${primaryButtonClass}">Send</button>
      </div>
    </form>

    ${chatClientScript({
      chatId: state.chat.id,
      currentUserId: state.currentUserId,
      participants: state.chat.participants.map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        lastReadSeq: p.lastReadSeq,
      })),
      lastSeq,
    })}`,
  );
};

export const chatErrorPage = (title: string, message: string): string =>
  pageShell(
    title,
    `
    <h1 class="text-2xl font-semibold text-gray-900">${escapeHtml(title)}</h1>
    <p class="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
      ${escapeHtml(message)}
    </p>
    <p class="mt-6 flex flex-wrap gap-3">
      <a href="/chats" class="${secondaryButtonClass}">Back to chats</a>
      <a href="/search" class="${secondaryButtonClass}">Browse listings</a>
    </p>`,
  );
