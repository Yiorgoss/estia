import type { ChatDetail, ChatInbox, ChatMessage, ChatMessages } from "@/db/schema/Chat";
import type { UserId } from "@/db/schema/brands";
import {
  errorBanner,
  pageShell,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/frontend/layout";
import { escapeHtml, formatDateTime } from "@/utils";

/*
 * The two chat pages: the caller's inbox and one thread.
 *
 * Both are server-rendered. The thread page carries one small inline script that
 * upgrades it to live delivery: it opens the socket after the newest sequence
 * number it rendered, appends what arrives, acknowledges what the visible thread
 * has shown, and reconnects with that same number after a drop or a back/forward
 * cache restore, so a hibernated object and a sleeping laptop both resume where
 * the reader left off. Without the script the page still works - the form posts
 * to the no-socket fallback and the browser reloads the thread.
 */

const counterpartOf = (detail: ChatDetail, userId: typeof UserId.Type) =>
  detail.participants.find((participant) => participant.userId !== userId);

const isMine = (message: ChatMessage, userId: typeof UserId.Type) => message.senderId === userId;

const senderLabel = (
  detail: ChatDetail,
  message: ChatMessage,
  userId: typeof UserId.Type,
): string => {
  if (isMine(message, userId)) return "You";
  return counterpartOf(detail, userId)?.name ?? "Member";
};

const messageBoxClass = (mine: boolean) =>
  mine
    ? "rounded-lg border border-blue-100 bg-blue-50 p-3"
    : "rounded-lg border border-gray-200 bg-white p-3";

const messageItem = (
  detail: ChatDetail,
  message: ChatMessage,
  userId: typeof UserId.Type,
  extra = "",
): string => `
  <li class="${messageBoxClass(isMine(message, userId))}${extra}" data-seq="${message.seq}">
    <p class="text-xs font-medium text-gray-500">${escapeHtml(senderLabel(detail, message, userId))}</p>
    <p class="mt-1 whitespace-pre-line break-words text-sm text-gray-800">${escapeHtml(message.body)}</p>
    <time class="mt-1 block text-xs text-gray-400">${escapeHtml(formatDateTime(message.createdAt) ?? "")}</time>
  </li>`;

const inboxRow = (item: ChatInbox["items"][number]) => {
  const when = formatDateTime(item.lastMessageAt ?? item.createdAt);
  return `
  <li>
    <a href="/chats/${item.id}" class="flex items-start gap-3 border-b border-gray-100 p-4 last:border-b-0 hover:bg-gray-50">
      <span class="min-w-0 flex-1">
        <span class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span class="truncate text-sm font-semibold text-gray-900">${escapeHtml(item.counterpartName)}</span>
          <span class="shrink-0 text-xs text-gray-500">${escapeHtml(when ?? "")}</span>
        </span>
        <span class="mt-0.5 block truncate text-xs uppercase tracking-wide text-gray-500">${escapeHtml(item.listingTitle)}</span>
        <span class="mt-1 block truncate text-sm text-gray-600">${escapeHtml(item.lastMessagePreview ?? "No messages yet")}</span>
      </span>
      ${
        item.unreadCount > 0
          ? `<span class="shrink-0 rounded-full bg-blue-700 px-2 py-0.5 text-xs font-semibold text-white" aria-label="${item.unreadCount} unread">${item.unreadCount}</span>`
          : ""
      }
    </a>
  </li>`;
};

const emptyInbox = `
  <div class="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
    <h2 class="text-base font-semibold text-gray-900">No chats yet</h2>
    <p class="mt-1 text-sm text-gray-600">
      A chat starts when you message the owner of a listing you are interested in.
    </p>
    <a href="/search" class="mt-4 inline-block ${primaryButtonClass}">Browse listings</a>
  </div>`;

export const chatInboxPage = (inbox: ChatInbox, options: { readonly error?: string } = {}) =>
  pageShell(
    "Chats",
    `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Chats</h1>
        <p class="mt-1 text-sm text-gray-600">Every conversation you are part of, newest activity first.</p>
      </div>
      <a href="/search" class="${secondaryButtonClass}">Search listings</a>
    </div>

    <div class="mt-4 space-y-4">
      ${errorBanner(options.error)}
      ${
        inbox.items.length === 0
          ? emptyInbox
          : `<ul class="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              ${inbox.items.map(inboxRow).join("")}
            </ul>`
      }
    </div>
    `,
  );

/*
 * The thread. The data attributes are the script's whole configuration: which
 * chat, which account is reading it, the other side's name, and the newest
 * sequence number already on the page. The template is also its stylesheet - a
 * message the script appends is cloned from markup that is already on the page,
 * so the Tailwind build cannot be missing a class it has never seen.
 */
export const chatThreadPage = (
  detail: ChatDetail,
  messages: ChatMessages,
  options: {
    readonly userId: typeof UserId.Type;
    readonly error?: string;
    readonly draft?: string;
  },
) => {
  const counterpart = counterpartOf(detail, options.userId);
  const counterpartName = counterpart?.name ?? "Member";
  const backLink = `
    <a href="/chats" class="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:text-blue-800">
      &larr; All chats
    </a>`;

  return pageShell(
    `${counterpartName} - ${detail.listingTitle}`,
    `
    <div class="mt-4" id="chat"
         data-chat-id="${detail.id}"
         data-user-id="${escapeHtml(options.userId)}"
         data-counterpart="${escapeHtml(counterpartName)}"
         data-last-seq="${messages.lastSeq}"
         data-last-read-seq="${detail.lastReadSeq}">
      ${backLink}

      <article class="mt-3 rounded-lg border border-gray-200 bg-white shadow-sm">
        <header class="border-b border-gray-100 p-5">
          <h1 class="break-words text-xl font-semibold text-gray-900">${escapeHtml(counterpartName)}</h1>
          <p class="mt-1 text-sm text-gray-600">
            About
            <a href="/listings/${detail.listingId}" class="font-medium text-blue-700 hover:text-blue-800">${escapeHtml(detail.listingTitle)}</a>
          </p>
        </header>

        <div class="space-y-3 p-5">
          ${errorBanner(options.error)}
          <ul id="chat-messages" class="space-y-3" aria-live="polite">
            ${messages.items.map((message) => messageItem(detail, message, options.userId)).join("")}
          </ul>
          ${
            messages.items.length === 0
              ? `<p id="chat-empty" class="text-sm text-gray-500">No messages yet. Say hello.</p>`
              : ""
          }
        </div>

        <form id="chat-form" method="post" action="/chats/${detail.id}/messages" class="border-t border-gray-100 p-5">
          <label for="chat-body" class="block text-sm font-medium text-gray-900">Message</label>
          <textarea id="chat-body" name="body" rows="3" required maxlength="4000"
                    class="mt-2 block w-full rounded-md border border-gray-300 p-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none">${options.draft === undefined ? "" : escapeHtml(options.draft)}</textarea>
          <input type="hidden" name="clientMessageId" value="${crypto.randomUUID()}" />
          <div class="mt-3 flex items-center gap-3">
            <button type="submit" class="${primaryButtonClass}">Send</button>
            <p id="chat-status" class="text-sm text-gray-500" role="status"></p>
          </div>
        </form>
      </article>
    </div>

    <template id="chat-message-template">
      <li class="rounded-lg border border-gray-200 bg-white p-3">
        <p class="text-xs font-medium text-gray-500" data-role="who"></p>
        <p class="mt-1 whitespace-pre-line break-words text-sm text-gray-800" data-role="body"></p>
        <time class="mt-1 block text-xs text-gray-400" data-role="when"></time>
      </li>
    </template>

    <script>
      (() => {
        const root = document.getElementById("chat");
        if (root === null) return;
        const chatId = root.dataset.chatId;
        const userId = root.dataset.userId;
        const counterpart = root.dataset.counterpart;
        const list = document.getElementById("chat-messages");
        const form = document.getElementById("chat-form");
        const input = document.getElementById("chat-body");
        const status = document.getElementById("chat-status");
        const template = document.getElementById("chat-message-template");
        if (list === null || form === null || input === null || template === null) return;

        let lastSeq = Number(root.dataset.lastSeq || "0");
        let acknowledged = Number(root.dataset.lastReadSeq || "0");
        let socket = null;
        let retry = 0;
        let leaving = false;
        let pending = null;

        const setStatus = (text) => {
          if (status !== null) status.textContent = text;
        };

        const acknowledge = () => {
          if (document.visibilityState !== "visible" || lastSeq <= acknowledged) return;
          const seq = lastSeq;
          void fetch("/api/chats/" + chatId + "/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ seq: seq }),
          })
            .then((response) => {
              if (response.ok) acknowledged = Math.max(acknowledged, seq);
            })
            .catch(() => {});
        };

        const newId = () =>
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : String(Date.now()) + Math.random().toString(16).slice(2);

        const append = (message) => {
          const seq = Number(message.seq);
          if (!Number.isFinite(seq) || seq <= lastSeq) return;
          lastSeq = seq;

          const fragment = template.content.cloneNode(true);
          const item = fragment.querySelector("li");
          item.className =
            message.senderId === userId
              ? "rounded-lg border border-blue-100 bg-blue-50 p-3"
              : "rounded-lg border border-gray-200 bg-white p-3";
          item.dataset.seq = String(seq);
          fragment.querySelector('[data-role="who"]').textContent =
            message.senderId === userId ? "You" : counterpart;
          fragment.querySelector('[data-role="body"]').textContent = message.body;
          fragment.querySelector('[data-role="when"]').textContent = new Date(
            message.createdAt,
          ).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
          });

          const empty = document.getElementById("chat-empty");
          if (empty !== null) empty.remove();
          list.appendChild(fragment);
          item.scrollIntoView({ block: "end" });
          if (pending === null) setStatus("");
          acknowledge();
        };

        const connect = () => {
          if (leaving) return;
          const protocol = location.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(
            protocol + "//" + location.host + "/api/chats/" + chatId + "/socket?after=" + lastSeq,
          );
          socket.addEventListener("open", () => {
            retry = 0;
            setStatus("");
          });
          socket.addEventListener("message", (event) => {
            let frame;
            try {
              frame = JSON.parse(event.data);
            } catch {
              return;
            }
            if (frame.type === "message") {
              append(frame.message);
              if (pending !== null && frame.message.clientMessageId === pending.clientMessageId) {
                const sent = pending.body;
                pending = null;
                if (input.value.trim() === sent) input.value = "";
                setStatus("");
              }
            } else if (frame.type === "error") {
              if (pending !== null) {
                input.value = pending.body;
                pending = null;
              }
              setStatus(frame.message || "That message was refused.");
            }
          });
          socket.addEventListener("close", () => {
            socket = null;
            if (pending !== null) {
              input.value = pending.body;
              pending = null;
            }
            if (leaving) return;
            setStatus("Reconnecting...");
            const wait = Math.min(1000 * Math.pow(2, retry), 8000);
            retry += 1;
            setTimeout(connect, wait);
          });
        };

        form.addEventListener("submit", (event) => {
          if (socket === null || socket.readyState !== 1) return;
          event.preventDefault();
          if (pending !== null) return;
          const body = input.value.trim();
          if (body === "") return;
          pending = { clientMessageId: newId(), body: body };
          socket.send(
            JSON.stringify({
              type: "send",
              clientMessageId: pending.clientMessageId,
              body: pending.body,
            }),
          );
          setStatus("Sending...");
        });

        window.addEventListener("pagehide", () => {
          leaving = true;
          if (socket !== null) socket.close();
        });

        window.addEventListener("pageshow", (event) => {
          if (!event.persisted) return;
          leaving = false;
          if (socket === null) connect();
          acknowledge();
        });

        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") acknowledge();
        });

        connect();
      })();
    </script>
    `,
  );
};

/*
 * A refused chat action is still a page with a way forward: back to the thread or
 * list it came from, and back to search. The listing form's error page links to
 * the owner's own surfaces, which is the wrong offer for a person who was trying
 * to send a message.
 */
export const chatErrorPage = (
  title: string,
  message: string,
  options: { readonly backHref?: string; readonly backLabel?: string } = {},
) =>
  pageShell(
    title,
    `
    <h1 class="text-2xl font-semibold text-gray-900">${escapeHtml(title)}</h1>
    <p class="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
      ${escapeHtml(message)}
    </p>
    <p class="mt-6 flex flex-wrap items-center gap-3">
      <a href="${escapeHtml(options.backHref ?? "/chats")}" class="${secondaryButtonClass}">${escapeHtml(
        options.backLabel ?? "All chats",
      )}</a>
      <a href="/search" class="${secondaryButtonClass}">Back to search</a>
    </p>`,
  );
