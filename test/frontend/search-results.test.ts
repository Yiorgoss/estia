import { ListingId, UserId } from "@/db/schema/brands";
import { encodeListingCursor, ListingPage } from "@/db/schema/Listing";
import { searchResults, searchResultsError } from "@/frontend/search-results";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

type SearchListing = (typeof ListingPage.Type)["items"][number];

const listing = (overrides: Partial<SearchListing> = {}): SearchListing => ({
  id: Schema.decodeSync(ListingId)(1),
  kind: "room",
  ownerId: Schema.decodeSync(UserId)("u-search-results"),
  status: "published",
  title: "Sunny studio in Athens",
  description: "Bright, near the metro",
  priceMinor: 120_000,
  currency: "EUR",
  regionCode: "attica",
  lat: null,
  lng: null,
  sizeSqm: 42,
  availableFrom: new Date("2026-03-01T00:00:00.000Z"),
  furnished: true,
  ensuite: false,
  smoking: false,
  pets: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const page = (
  items: ReadonlyArray<SearchListing>,
  nextCursor: (typeof ListingPage.Type)["nextCursor"] = null,
): typeof ListingPage.Type => ({ items, nextCursor });

describe("searchResults", () => {
  it("renders a card with title, region, price, size, availability, and the true flags", () => {
    const html = searchResults(page([listing()]));

    assert.include(html, "Sunny studio in Athens");
    assert.include(html, "Attica");
    assert.include(html, "Room");
    assert.include(html, "€1,200");
    assert.include(html, "42 m²");
    assert.include(html, "Available 1 Mar 2026");
    assert.include(html, "Furnished");
    assert.include(html, "Pets allowed");
    assert.notInclude(html, "Ensuite");
    assert.notInclude(html, "Smoking allowed");
  });

  it("labels the count as what this page shows, never as a total", () => {
    assert.include(searchResults(page([listing()])), "Showing 1 listing, newest first");
    assert.include(
      searchResults(page([listing(), listing({ id: Schema.decodeSync(ListingId)(2) })])),
      "Showing 2 listings, newest first",
    );
    assert.notInclude(searchResults(page([listing()])), "found");
  });

  it("escapes user-supplied title and description", () => {
    const html = searchResults(
      page([
        listing({
          title: `<img src=x onerror=alert(1)>`,
          description: `<script>alert("xss")</script>`,
        }),
      ]),
    );

    assert.notInclude(html, "<img src=x");
    assert.notInclude(html, "<script>");
    assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
    assert.include(html, "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("falls back for a missing size and availability", () => {
    const html = searchResults(page([listing({ sizeSqm: null, availableFrom: null })]));

    assert.include(html, "Size unknown");
    assert.include(html, "Availability unknown");
  });

  it("renders an empty state instead of a count when nothing matches", () => {
    const html = searchResults(page([]));

    assert.include(html, "No listings match these filters.");
    assert.notInclude(html, "Showing");
  });

  it("offers a next page only when the server returned a cursor", () => {
    const cursor = { createdAt: 1_700_000_000_000, id: Schema.decodeSync(ListingId)(7) };
    const withMore = searchResults(page([listing()], cursor));

    assert.include(withMore, "Next page");
    assert.include(withMore, 'hx-get="/search/results"');
    assert.include(withMore, 'hx-include="#search-form"');
    assert.include(withMore, 'hx-target="#results"');
    assert.include(withMore, `hx-vals='{"cursor":"${encodeListingCursor(cursor)}"}'`);
    // Keyset paging does not go backwards.
    assert.notInclude(withMore, "Previous page");

    assert.notInclude(searchResults(page([listing()])), "Next page");
  });
});

describe("searchResultsError", () => {
  it("escapes the message", () => {
    assert.notInclude(searchResultsError(`<b>"nope"</b>`), "<b>");
    assert.include(searchResultsError(`<b>"nope"</b>`), "&lt;b&gt;&quot;nope&quot;&lt;/b&gt;");
  });
});
