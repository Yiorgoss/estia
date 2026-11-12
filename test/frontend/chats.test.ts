import { ChatId, ChatMessageId, ListingId, UserId } from "@/db/schema/brands";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_MESSAGE_PAGE_MAX_LIMIT,
  type ChatDetail,
  type ChatInbox,
  type ChatMessage,
  type ChatMessages,
} from "@/db/schema/Chat";
import {
  NEW_MESSAGES_THRESHOLD_PX,
  chatErrorPage,
  chatInboxPage,
  chatThreadPage,
  nextAcknowledgedSeq,
  shouldFollowNewMessage,
} from "@/frontend/pages/chats";
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

const thread = (
  messages: ReadonlyArray<ChatMessage>,
  lastSeq = 2,
  hasEarlier = false,
): ChatMessages => ({
  items: messages,
  lastSeq,
  hasEarlier,
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
    assert.include(html, 'id="chat-new-messages"');
    assert.include(html, "hidden>New messages</button>");
  });

  it("offers the earlier page only while older messages exist", () => {
    const withEarlier = chatThreadPage(detail(), thread([message({ seq: 100 })], 100, true), {
      userId: user("user-owner"),
    });
    assert.include(withEarlier, 'id="chat-load-earlier"');
    assert.include(withEarlier, 'data-before="100"');
    assert.include(withEarlier, `data-limit="${CHAT_MESSAGE_PAGE_MAX_LIMIT}"`);
    assert.include(withEarlier, "Load earlier messages");

    const earliest = chatThreadPage(detail(), thread([message({ seq: 1 })], 1, false), {
      userId: user("user-owner"),
    });
    assert.notInclude(earliest, 'id="chat-load-earlier"');
  });

  it("renders a full page of history with the newest message last", () => {
    const items = Array.from({ length: 150 }, (_, index) =>
      message({
        id: Schema.decodeSync(ChatMessageId)(index + 1),
        seq: index + 1,
        body: `message ${index + 1}`,
      }),
    );
    const html = chatThreadPage(detail({ lastSeq: 150 }), thread(items, 150, true), {
      userId: user("user-owner"),
    });

    assert.include(html, 'data-last-seq="150"');
    assert.include(html, 'data-seq="150"');
    assert.isBelow(html.indexOf('data-seq="149"'), html.indexOf('data-seq="150"'));
    assert.include(html, 'id="chat-load-earlier"');
  });

  it("carries the submitted client message id into an error re-render", () => {
    const html = chatThreadPage(detail(), thread([message()]), {
      userId: user("user-seeker"),
      error: "That message could not be sent.",
      clientMessageId: "submitted-id",
    });

    assert.include(html, 'name="clientMessageId" value="submitted-id"');
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

describe("shouldFollowNewMessage", () => {
  it("follows at or near the bottom and leaves a scrolled-up reader alone", () => {
    assert.isTrue(shouldFollowNewMessage(0, NEW_MESSAGES_THRESHOLD_PX));
    assert.isTrue(shouldFollowNewMessage(NEW_MESSAGES_THRESHOLD_PX, NEW_MESSAGES_THRESHOLD_PX));
    assert.isFalse(
      shouldFollowNewMessage(NEW_MESSAGES_THRESHOLD_PX + 1, NEW_MESSAGES_THRESHOLD_PX),
    );
    assert.isFalse(shouldFollowNewMessage(800, NEW_MESSAGES_THRESHOLD_PX));
  });
});

describe("nextAcknowledgedSeq", () => {
  it("advances only when the newest message is at the bottom and newer than the mark", () => {
    assert.strictEqual(nextAcknowledgedSeq(10, 5, true), 10);
    assert.isUndefined(nextAcknowledgedSeq(10, 5, false));
    assert.isUndefined(nextAcknowledgedSeq(5, 5, true));
    assert.isUndefined(nextAcknowledgedSeq(4, 5, true));
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
