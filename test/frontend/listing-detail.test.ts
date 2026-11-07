import { ListingId } from "@/db/schema/brands";
import {
  listingDetailPage,
  listingNotFoundPage,
  listingUnavailablePage,
} from "@/frontend/pages/listing-detail";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

type PublicListing = Parameters<typeof listingDetailPage>[0];

const listing = (overrides: Partial<PublicListing> = {}): PublicListing => ({
  id: Schema.decodeSync(ListingId)(7),
  kind: "room",
  title: "Sunny studio in Athens",
  description: "Bright, near the metro",
  priceMinor: 120_000,
  currency: "EUR",
  regionCode: "attica",
  sizeSqm: 42,
  furnished: true,
  ensuite: false,
  smoking: false,
  pets: true,
  availableFrom: new Date("2026-03-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-03T00:00:00.000Z"),
  ...overrides,
});

describe("listingDetailPage", () => {
  it("renders the listing's public facts", () => {
    const html = listingDetailPage(listing());

    assert.include(html, "Sunny studio in Athens");
    assert.include(html, "Attica");
    assert.include(html, "Room");
    assert.include(html, "€1,200");
    assert.include(html, "Bright, near the metro");
    assert.include(html, "42 m²");
    assert.include(html, "Available from");
    assert.include(html, "1 Mar 2026");
    assert.include(html, "Published");
    assert.include(html, "3 Jan 2026");
    // Only the true flags read as chips.
    assert.include(html, "Furnished");
    assert.include(html, "Pets allowed");
    assert.notInclude(html, "Ensuite");
    assert.notInclude(html, "Smoking allowed");
  });

  it("carries shareable title and description metadata", () => {
    const html = listingDetailPage(listing());

    assert.include(html, "<title>Sunny studio in Athens - Attica</title>");
    assert.include(html, '<meta name="description" content="Bright, near the metro">');
    assert.include(html, 'property="og:title"');
    assert.include(html, 'property="og:description"');
    // A published listing is indexable and offers the way back.
    assert.notInclude(html, 'name="robots"');
    assert.include(html, 'href="/search"');
  });

  it("falls back to a summary when the listing has no description", () => {
    const html = listingDetailPage(listing({ description: null }));

    assert.include(html, "No description provided.");
    assert.include(html, 'content="Room in Attica, €1,200 per month."');
  });

  it("summarises a long description instead of pasting it into the metadata", () => {
    const long = "word ".repeat(100).trim();
    const html = listingDetailPage(listing({ description: long }));

    assert.notInclude(html, `content="${long}"`);
    const match = /<meta name="description" content="([^"]*)">/.exec(html);
    assert.isNotNull(match);
    assert.isAtMost((match?.[1] ?? "").length, 160);
    assert.include(match?.[1] ?? "", "…");
  });

  it("escapes the title and description, in the body and in the metadata", () => {
    const html = listingDetailPage(
      listing({
        title: `<img src=x onerror=alert(1)>`,
        description: `<script>alert("xss")</script>`,
      }),
    );

    assert.notInclude(html, "<img src=x");
    assert.notInclude(html, "<script>");
    assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
    assert.include(html, "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("falls back for a missing size, availability, and publish date", () => {
    const html = listingDetailPage(
      listing({ sizeSqm: null, availableFrom: null, publishedAt: null }),
    );

    assert.include(html, "Not stated");
    assert.notInclude(html, "42 m²");
    assert.include(html, "Sunny studio in Athens");
  });
});

describe("listingNotFoundPage", () => {
  it("renders a clean not-found page with a way back to search", () => {
    const html = listingNotFoundPage();

    assert.include(html, "Listing not found");
    assert.include(html, "This listing does not exist, or it is no longer published.");
    assert.include(html, 'href="/search"');
    assert.include(html, "<title>Listing not found</title>");
    // A visitor's dead end should not be indexed or previewed as a listing.
    assert.include(html, '<meta name="robots" content="noindex">');
    assert.notInclude(html, "Something went wrong");
  });
});

describe("listingUnavailablePage", () => {
  it("explains a transient failure and still offers the way back", () => {
    const html = listingUnavailablePage();

    assert.include(html, "Something went wrong");
    assert.include(html, "Please try again.");
    assert.include(html, 'href="/search"');
  });
});
