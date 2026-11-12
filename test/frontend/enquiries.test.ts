import { encodeKeysetCursor } from "@/db/schema/cursor";
import type { ReceivedEnquiry, SentEnquiry } from "@/db/schema/Enquiry";
import { enquiriesPage } from "@/frontend/pages/enquiries";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { EnquiryId, ListingId } from "@/db/schema/brands";

/*
 * The enquiries page is the other half of the contact path: the lister reads who
 * wrote and when, the seeker reads what they sent, and an empty list says so
 * instead of looking broken. Every value here came from a person, so escaping is
 * part of the test.
 */

const received = (overrides: Partial<ReceivedEnquiry> = {}): ReceivedEnquiry => ({
  id: Schema.decodeSync(EnquiryId)(1),
  listingId: Schema.decodeSync(ListingId)(7),
  listingTitle: "Sunny studio in Athens",
  senderName: "Ada Seeker",
  senderContact: "ada@example.test",
  message: "Is the room still available?",
  createdAt: new Date("2026-11-11T09:30:00.000Z"),
  ...overrides,
});

const sent = (overrides: Partial<SentEnquiry> = {}): SentEnquiry => ({
  id: Schema.decodeSync(EnquiryId)(2),
  listingId: Schema.decodeSync(ListingId)(7),
  listingTitle: "Sunny studio in Athens",
  message: "Is the room still available?",
  createdAt: new Date("2026-11-11T09:30:00.000Z"),
  ...overrides,
});

describe("enquiriesPage", () => {
  it("renders both sides with who sent it and when", () => {
    const html = enquiriesPage({
      received: { items: [received()], nextCursor: null },
      sent: { items: [sent()], nextCursor: null },
    });

    assert.include(html, "Enquiries your listings received");
    assert.include(html, "Ada Seeker");
    assert.include(html, "ada@example.test");
    assert.include(html, "Is the room still available?");
    assert.include(html, 'href="/listings/7"');
    assert.include(html, "Sunny studio in Athens");
    assert.include(html, "Enquiries you sent");
    // The time is part of the record, not only the day.
    assert.include(html, "11 Nov 2026");
    assert.include(html, "09:30");
  });

  it("explains an empty list on each side", () => {
    const html = enquiriesPage({
      received: { items: [], nextCursor: null },
      sent: { items: [], nextCursor: null },
    });

    assert.include(html, "No enquiries yet");
    assert.include(html, "You have not sent an enquiry yet");
  });

  it("confirms a send once and only once", () => {
    const pages = {
      received: { items: [], nextCursor: null },
      sent: { items: [], nextCursor: null },
    };
    const banner = enquiriesPage({ ...pages, sentBanner: true });
    assert.include(banner, "Your enquiry was sent");
    assert.include(
      banner,
      "the display name and contact details from your profile, or your account email when those are not published",
    );
    assert.notInclude(enquiriesPage(pages), "Your enquiry was sent");
  });

  it("does not carry the send confirmation into a next page link", () => {
    const next = { createdAt: 1_700_000_000_000, id: 7 };
    const html = enquiriesPage({
      received: { items: [received()], nextCursor: next },
      sent: { items: [sent()], nextCursor: next },
      sentBanner: true,
    });

    assert.include(html, "Your enquiry was sent");
    assert.include(html, "Next page");
    assert.notInclude(html, "sent=1");
  });

  it("links each list to its next page independently", () => {
    const receivedNext = { createdAt: 1_700_000_000_000, id: 7 };
    const sentCursor = { createdAt: 1_699_000_000_000, id: 3 };
    const html = enquiriesPage({
      received: { items: [received()], nextCursor: receivedNext },
      sent: { items: [sent()], nextCursor: null },
      sentCursor,
    });

    assert.include(
      html,
      `href="/enquiries?receivedCursor=${encodeKeysetCursor(receivedNext)}&amp;sentCursor=${encodeKeysetCursor(sentCursor)}"`,
    );
    assert.include(html, "Next page");
    assert.strictEqual(html.split("Next page").length - 1, 1);
  });

  it("escapes everything a person supplied", () => {
    const html = enquiriesPage({
      received: {
        items: [
          received({
            listingTitle: `<script>alert("title")</script>`,
            senderName: `<img src=x onerror=alert(1)>`,
            senderContact: `<b>contact</b>`,
            message: `<script>alert("message")</script>`,
          }),
        ],
        nextCursor: null,
      },
      sent: {
        items: [sent({ message: `<script>alert("sent")</script>` })],
        nextCursor: null,
      },
    });

    assert.notInclude(html, "<script>");
    assert.notInclude(html, "<img src=x");
    assert.notInclude(html, "<b>contact</b>");
    assert.include(html, "&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
    assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
  });
});
