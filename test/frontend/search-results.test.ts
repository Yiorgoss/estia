import { ListerId, RoomId } from "@/db/schema/brands";
import { RoomSchema } from "@/db/schema/Room";
import { searchResults, searchResultsError } from "@/frontend/search-results";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

const room = (overrides: Partial<typeof RoomSchema.Type> = {}): typeof RoomSchema.Type => ({
  id: Schema.decodeUnknownSync(RoomId)(1),
  listerId: Schema.decodeUnknownSync(ListerId)(1),
  price: 1200,
  location: "Athens",
  description: "Sunny studio",
  size: 42,
  furnished: true,
  ensuite: false,
  smoking: false,
  pets: true,
  availableFrom: new Date("2026-03-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("searchResults", () => {
  it("renders a card with price, size, availability, and the true flags", () => {
    const html = searchResults([room()]);

    assert.include(html, "1 room found");
    assert.include(html, "Athens");
    assert.include(html, "€1,200");
    assert.include(html, "42 m²");
    assert.include(html, "Available 1 Mar 2026");
    assert.include(html, "Furnished");
    assert.include(html, "Pets allowed");
    assert.notInclude(html, "Ensuite");
    assert.notInclude(html, "Smoking allowed");
  });

  it("escapes user-supplied location and description", () => {
    const html = searchResults([
      room({
        location: `<img src=x onerror=alert(1)>`,
        description: `<script>alert("xss")</script>`,
      }),
    ]);

    assert.notInclude(html, "<img src=x");
    assert.notInclude(html, "<script>");
    assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
    assert.include(html, "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("falls back for a missing size and availability", () => {
    const html = searchResults([room({ size: null, availableFrom: null })]);

    assert.include(html, "Size unknown");
    assert.include(html, "Availability unknown");
  });

  it("renders an empty state instead of a count when nothing matches", () => {
    const html = searchResults([]);

    assert.include(html, "No rooms match these filters.");
    assert.notInclude(html, "rooms found");
  });
});

describe("searchResultsError", () => {
  it("escapes the message", () => {
    assert.notInclude(searchResultsError(`<b>"nope"</b>`), "<b>");
    assert.include(searchResultsError(`<b>"nope"</b>`), "&lt;b&gt;&quot;nope&quot;&lt;/b&gt;");
  });
});
