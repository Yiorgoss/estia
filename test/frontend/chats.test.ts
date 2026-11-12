import { ChatId, ChatMessageId, ListingId, UserId } from "@/db/schema/brands";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatDetail,
  type ChatInbox,
  type ChatMessage,
  type ChatMessages,
} from "@/db/schema/Chat";
import { chatErrorPage, chatInboxPage, chatThreadPage } from "@/frontend/pages/chats";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

const user = (value: string) => Schema.decodeSync(UserId)(value);

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: Schema.decodeSync(ChatMessageId)(1),
  chatId: Schema.decodeSync(ChatId)(4),
  seq: 1,
  senderId: user("user-seeker"),
  body: "Is the room still free?",
  clientMessageId: "client-1",
  createdAt: new Date("2026-11-12T10:15:00.000Z"),
  ...overrides,
});

const detail = (overrides: Partial<ChatDetail> = {}): ChatDetail => ({
  id: Schema.decodeSync(ChatId)(4),
  listingId: Schema.decodeSync(ListingId)(9),
  listingTitle: "Sunny studio in Athens",
  createdAt: new Date("2026-11-12T10:00:00.000Z"),
  lastSeq: 2,
  lastReadSeq: 2,
  participants: [
    { userId: user("user-owner"), name: "Owner Name", lastReadSeq: 2 },
    { userId: user("user-seeker"), name: "Seeker Name", lastReadSeq: 2 },
  ],
  ...overrides,
});

const thread = (messages: ReadonlyArray<ChatMessage>, lastSeq = 2): ChatMessages => ({
  items: messages,
  lastSeq,
});

describe("chatInboxPage", () => {
  it("renders one row per chat with the counterpart, the listing, a preview and the badge", () => {
    const inbox: ChatInbox = {
      items: [
        {
          id: Schema.decodeSync(ChatId)(4),
          listingId: Schema.decodeSync(ListingId)(9),
          listingTitle: "Sunny studio in Athens",
          counterpartUserId: user("user-owner"),
          counterpartName: "Owner Name",
          lastSeq: 3,
          lastMessageAt: new Date("2026-11-12T10:20:00.000Z"),
          lastMessagePreview: "Yes, it is available",
          unreadCount: 2,
          createdAt: new Date("2026-11-12T10:00:00.000Z"),
        },
      ],
    };

    const html = chatInboxPage(inbox);

    assert.include(html, "Owner Name");
    assert.include(html, "Sunny studio in Athens");
    assert.include(html, "Yes, it is available");
    assert.include(html, 'href="/chats/4"');
    assert.include(html, ">2</span>");
    assert.include(html, "12 Nov, 10:20");
  });

  it("shows the empty state instead of a bare list", () => {
    const html = chatInboxPage({ items: [] });
    assert.include(html, "No chats yet");
    assert.include(html, "Browse listings");
  });

  it("explains a failed load without claiming the list is empty", () => {
    const html = chatInboxPage(
      { items: [] },
      { error: "Your chats could not be loaded just now. Please try again." },
    );
    assert.include(html, "could not be loaded");
  });

  it("shows an unread-free row without a badge", () => {
    const html = chatInboxPage({
      items: [
        {
          id: Schema.decodeSync(ChatId)(5),
          listingId: Schema.decodeSync(ListingId)(9),
          listingTitle: "Quiet flat",
          counterpartUserId: user("user-owner"),
          counterpartName: "Owner Name",
          lastSeq: 1,
          lastMessageAt: null,
          lastMessagePreview: "Hello",
          unreadCount: 0,
          createdAt: new Date("2026-11-12T10:00:00.000Z"),
        },
      ],
    });
    assert.notInclude(html, 'aria-label="0 unread"');
    assert.include(html, "Hello");
  });
});

describe("chatThreadPage", () => {
  it("renders the thread, labels the reader's own messages, and carries the socket configuration", () => {
    const messages = thread([
      message(),
      message({
        id: Schema.decodeSync(ChatMessageId)(2),
        seq: 2,
        senderId: user("user-owner"),
        body: "Yes, it is still free",
        createdAt: new Date("2026-11-12T10:20:00.000Z"),
      }),
    ]);

    const html = chatThreadPage(detail(), messages, { userId: user("user-owner") });

    assert.include(html, 'data-chat-id="4"');
    assert.include(html, 'data-user-id="user-owner"');
    assert.include(html, 'data-last-seq="2"');
    assert.include(html, 'data-last-read-seq="2"');
    // The header names the other side, not the reader.
    assert.include(html, ">Seeker Name</h1>");
    assert.include(html, "Sunny studio in Athens");
    assert.include(html, 'href="/listings/9"');
    assert.include(html, 'action="/chats/4/messages"');
    assert.include(html, `maxlength="${CHAT_MESSAGE_MAX_LENGTH}"`);
    assert.include(html, 'data-seq="1"');
    assert.include(html, 'data-seq="2"');
    // The reader's own message reads as "You", the counterpart's by name.
    assert.include(html, ">You</p>");
    assert.include(html, ">Seeker Name</p>");
    assert.include(html, "12 Nov, 10:20");
    // The socket client and the element it clones for a live message.
    assert.include(html, 'id="chat-message-template"');
  });

  it("escapes a message body instead of executing it", () => {
    const html = chatThreadPage(
      detail(),
      thread([message({ body: "<img src=x onerror=alert(1)>" })]),
      { userId: user("user-owner") },
    );

    assert.notInclude(html, "<img src=x onerror=alert(1)>");
    assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
  });

  it("offers the send box on an empty thread", () => {
    const html = chatThreadPage(detail({ lastSeq: 0 }), thread([], 0), {
      userId: user("user-seeker"),
    });

    assert.include(html, "No messages yet");
    assert.include(html, 'name="body"');
    assert.include(html, 'name="clientMessageId"');
    assert.include(html, 'data-last-seq="0"');
  });

  it("shows a rejected message above the thread it was written on", () => {
    const html = chatThreadPage(detail(), thread([message()]), {
      userId: user("user-seeker"),
      error: "Wait a few seconds, then send your message again.",
    });

    assert.include(html, "Wait a few seconds");
  });

  it("keeps the rejected draft in the form and escapes it", () => {
    const draft = '<script>alert("draft")</script>';
    const html = chatThreadPage(detail(), thread([message()]), {
      userId: user("user-seeker"),
      error: "That message could not be sent.",
      draft,
    });

    assert.include(html, "&lt;script&gt;alert(&quot;draft&quot;)&lt;/script&gt;");
    assert.notInclude(html, draft);
  });
});

describe("chatErrorPage", () => {
  it("offers the chats list by default and the page the form came from when it is named", () => {
    const defaultPage = chatErrorPage("Chat not found", "That chat does not exist.");
    assert.include(defaultPage, "That chat does not exist.");
    assert.include(defaultPage, 'href="/chats"');

    const listingPage = chatErrorPage("That message could not be sent", "Nope.", {
      backHref: "/listings/9",
      backLabel: "Back to the listing",
    });
    assert.include(listingPage, 'href="/listings/9"');
    assert.include(listingPage, "Back to the listing");
  });
});
