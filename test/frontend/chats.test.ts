import { ChatId, ChatMessageId, ListingId, UserId } from "@/db/schema/brands";
import type { ChatDetail, ChatMessage, ChatParticipant, ChatSummary } from "@/db/schema/Chat";
import {
  chatDetailPage,
  chatErrorPage,
  chatsInboxPage,
  formatChatRoleLabel,
} from "@/frontend/pages/chats";
import { listingDetailPage } from "@/frontend/pages/listing-detail";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

const chatId = Schema.decodeSync(ChatId)("abcdef0123456789");
const listingId = Schema.decodeSync(ListingId)(42);
const seekerId = Schema.decodeSync(UserId)("u-seeker");
const listerId = Schema.decodeSync(UserId)("u-lister");
const managerId = Schema.decodeSync(UserId)("u-manager");

const defaultParticipants: ReadonlyArray<ChatParticipant> = [
  { userId: listerId, role: "lister", displayName: "Maria", lastReadSeq: 1 },
  { userId: seekerId, role: "seeker", displayName: "Eleni", lastReadSeq: 0 },
];

const summary = (overrides: Partial<ChatSummary> = {}): ChatSummary => ({
  id: chatId,
  listingId,
  directKey: `listing:${listingId}:seeker:${seekerId}`,
  listingTitle: "Sunny room in Thessaloniki",
  listingRegionCode: "central_macedonia",
  listingPriceMinor: 55_000,
  myRole: "seeker",
  participants: defaultParticipants,
  lastSeq: 2,
  lastReadSeq: 0,
  unreadCount: 2,
  lastMessageBody: "Hello, is it free?",
  lastMessageSenderId: listerId,
  lastMessageAt: new Date("2026-11-20T12:00:00.000Z"),
  createdAt: new Date("2026-11-20T11:00:00.000Z"),
  ...overrides,
});

const detail = (overrides: Partial<ChatDetail> = {}): ChatDetail => ({
  ...summary(),
  ...overrides,
});

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: Schema.decodeSync(ChatMessageId)(1),
  chatId,
  seq: 1,
  senderId: seekerId,
  clientMessageId: "c-1",
  body: "Hi there!",
  createdAt: new Date("2026-11-20T11:05:00.000Z"),
  ...overrides,
});

describe("chat pages", () => {
  it("formats standard and custom participant roles cleanly", () => {
    assert.strictEqual(formatChatRoleLabel("lister"), "Lister");
    assert.strictEqual(formatChatRoleLabel("seeker"), "Seeker");
    assert.strictEqual(formatChatRoleLabel("property_manager"), "Property manager");
    assert.strictEqual(formatChatRoleLabel("support-agent"), "Support agent");
  });

  it("renders the inbox list with unread badge and escapes participant names, roles, and previews", () => {
    const html = chatsInboxPage({
      items: [
        summary({
          participants: [
            {
              userId: listerId,
              role: `<b>agent</b>`,
              displayName: `<script>alert("x")</script>`,
              lastReadSeq: 1,
            },
            { userId: seekerId, role: "seeker", displayName: "Eleni", lastReadSeq: 0 },
          ],
          lastMessageBody: `<img src=x onerror=alert(1)>`,
        }),
      ],
      totalUnread: 2,
      currentUserId: seekerId,
    });

    assert.include(html, "2 unread messages");
    assert.include(html, `href="/chats/${chatId}"`);
    assert.include(html, "data-unread-badge");
    assert.notInclude(html, `<script>alert("x")</script>`);
    assert.notInclude(html, "<img src=x");
    assert.notInclude(html, "<b>agent</b>");
    assert.include(html, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders an empty inbox state when the user has no chats", () => {
    const html = chatsInboxPage({ items: [], totalUnread: 0, currentUserId: seekerId });
    assert.include(html, "No chats yet");
    assert.include(html, 'href="/search"');
  });

  it("renders the single chat page with messages, fallback form, and WebSocket script", () => {
    const html = chatDetailPage({
      chat: detail(),
      messages: [
        message({ seq: 1, body: "First message" }),
        message({
          id: Schema.decodeSync(ChatMessageId)(2),
          seq: 2,
          senderId: listerId,
          clientMessageId: "c-2",
          body: "<b>Reply</b>",
        }),
      ],
      currentUserId: seekerId,
    });

    assert.include(html, 'href="/chats"');
    assert.include(html, `action="/chats/${chatId}/messages"`);
    assert.include(html, "/api/chats/");
    assert.include(html, "First message");
    assert.include(html, "&lt;b&gt;Reply&lt;/b&gt;");
    assert.notInclude(html, "<b>Reply</b>");
    assert.include(html, "Maria read up to #1");
  });

  it("renders 3+ participant chats with custom roles and distinct sender names", () => {
    const multiParticipants: ReadonlyArray<ChatParticipant> = [
      { userId: listerId, role: "lister", displayName: "Maria", lastReadSeq: 2 },
      { userId: managerId, role: "property_manager", displayName: "Kostas", lastReadSeq: 1 },
      { userId: seekerId, role: "seeker", displayName: "Eleni", lastReadSeq: 2 },
    ];

    const inboxHtml = chatsInboxPage({
      items: [summary({ directKey: null, participants: multiParticipants })],
      totalUnread: 2,
      currentUserId: seekerId,
    });
    assert.include(inboxHtml, "Maria, Kostas");
    assert.include(inboxHtml, "Lister");
    assert.include(inboxHtml, "Property manager");

    const detailHtml = chatDetailPage({
      chat: detail({ directKey: null, participants: multiParticipants }),
      messages: [
        message({ seq: 1, senderId: listerId, body: "From lister" }),
        message({
          id: Schema.decodeSync(ChatMessageId)(2),
          seq: 2,
          senderId: managerId,
          clientMessageId: "c-2",
          body: "From manager",
        }),
      ],
      currentUserId: seekerId,
    });
    assert.include(detailHtml, "Maria, Kostas");
    assert.include(detailHtml, "Property manager");
    assert.include(detailHtml, "Maria read up to #2");
    assert.include(detailHtml, "Kostas read up to #1");
    assert.include(detailHtml, "From manager");
  });

  it("renders chat error pages cleanly", () => {
    const html = chatErrorPage("Access denied", "You are not a participant in this chat.");
    assert.include(html, "Access denied");
    assert.include(html, 'href="/chats"');
  });

  it("renders the listing detail contact CTA variants cleanly", () => {
    const listing = {
      id: listingId,
      kind: "room" as const,
      title: "Studio",
      description: "Nice",
      priceMinor: 60_000,
      currency: "EUR" as const,
      regionCode: "attica" as const,
      sizeSqm: 30,
      furnished: true,
      ensuite: false,
      smoking: false,
      pets: false,
      availableFrom: null,
      publishedAt: null,
      photos: [],
    };

    assert.include(listingDetailPage(listing, { kind: "sign-in" }), "Sign in to message");
    assert.include(listingDetailPage(listing, { kind: "owner" }), 'href="/chats"');
    assert.include(
      listingDetailPage(listing, { kind: "start-chat" }),
      `action="/listings/${listingId}/chat"`,
    );
    assert.include(
      listingDetailPage(listing, { kind: "open-chat", chatId }),
      `href="/chats/${chatId}"`,
    );
  });
});
