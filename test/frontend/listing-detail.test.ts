import { ListingId, ListingPhotoId } from "@/db/schema/brands";
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
  photos: [],
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

  it("renders the gallery with the first photo and the rest below it", () => {
    const html = listingDetailPage(
      listing({
        photos: [
          { id: Schema.decodeSync(ListingPhotoId)(1), url: "/listings/7/photos/1" },
          { id: Schema.decodeSync(ListingPhotoId)(2), url: "/listings/7/photos/2" },
        ],
      }),
    );

    assert.include(html, "Photos");
    assert.include(html, 'src="/listings/7/photos/1"');
    assert.include(html, 'src="/listings/7/photos/2"');
    assert.include(html, 'alt="Sunny studio in Athens - photo 1"');
    assert.include(html, 'alt="Sunny studio in Athens - photo 2"');
  });

  it("renders a listing with no photos without an empty gallery", () => {
    const html = listingDetailPage(listing());

    assert.notInclude(html, "Photos");
    assert.notInclude(html, "<img");
    assert.include(html, "Sunny studio in Athens");
    assert.include(html, "Bright, near the metro");
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

describe("listingDetailPage contact path", () => {
  it("prompts an anonymous reader to sign in and renders no contact details", () => {
    const html = listingDetailPage(listing());

    assert.include(html, "Contact the lister");
    assert.include(html, "Sign in to contact");
    assert.include(html, 'href="/login"');
    // The form and the lister's published line are signed-in surfaces only.
    assert.notInclude(html, 'action="/listings/7/enquiries"');
    assert.notInclude(html, "ada@example.test");
  });

  it("shows a signed-in reader the lister's published contact line and the enquiry form", () => {
    const html = listingDetailPage(listing(), {
      signedIn: true,
      listerName: "Ada Lets",
      listerContact: "ada@example.test",
    });

    assert.include(html, "Listed by");
    assert.include(html, "Ada Lets");
    assert.include(html, "Contact:");
    assert.include(html, "ada@example.test");
    assert.include(html, 'action="/listings/7/enquiries"');
    assert.include(html, 'name="message"');
    assert.include(html, "Send enquiry");
    assert.include(html, "Up to 2000 characters.");
    assert.notInclude(html, "Sign in to contact");
  });

  it("shows the sender the identity the lister will read", () => {
    const html = listingDetailPage(listing(), {
      signedIn: true,
      listerName: "Ada Lets",
      listerContact: "lets@example.test",
      senderIdentity: { name: "Ada Seeker", contact: "ada@example.test" },
    });

    assert.include(
      html,
      "The lister sees this on an enquiry you send: Ada Seeker - ada@example.test.",
    );
    assert.notInclude(html, "other profile");
  });

  it("says an enquiry cannot be sent when the sender has no contact to show", () => {
    const html = listingDetailPage(listing(), {
      signedIn: true,
      listerName: "Ada Lets",
      listerContact: "lets@example.test",
      senderIdentity: { name: "Ada Seeker", contact: null },
    });

    assert.include(
      html,
      "An enquiry cannot be sent until you add a contact detail to your profile.",
    );
    assert.notInclude(html, "The lister sees this on an enquiry you send:");
  });

  it("says so when the lister published no contact details and still offers the form", () => {
    const html = listingDetailPage(listing(), {
      signedIn: true,
      listerName: null,
      listerContact: null,
    });

    assert.include(html, "has not published contact details");
    assert.include(html, 'action="/listings/7/enquiries"');
  });

  it("offers the owner their enquiries instead of a form to themselves", () => {
    const html = listingDetailPage(listing(), { signedIn: true, isOwner: true });

    assert.include(html, "This is your listing");
    assert.include(html, 'href="/enquiries"');
    assert.notInclude(html, 'action="/listings/7/enquiries"');
  });

  it("escapes a published contact line, the typed message, and the refusal", () => {
    const html = listingDetailPage(listing(), {
      signedIn: true,
      listerName: `<img src=x onerror=alert(1)>`,
      listerContact: `<script>alert("contact")</script>`,
      senderIdentity: { name: `<b>sender</b>`, contact: `<i>contact</i>` },
      enquiryMessage: `<script>alert("message")</script>`,
      enquiryError: `<b>no</b>`,
    });

    assert.notInclude(html, "<img src=x");
    assert.notInclude(html, "<script>");
    assert.notInclude(html, "<b>no</b>");
    assert.notInclude(html, "<b>sender</b>");
    assert.notInclude(html, "<i>contact</i>");
    assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
    assert.include(html, "&lt;script&gt;alert(&quot;contact&quot;)&lt;/script&gt;");
    assert.include(html, "&lt;script&gt;alert(&quot;message&quot;)&lt;/script&gt;");
    assert.include(html, "&lt;b&gt;no&lt;/b&gt;");
    assert.include(html, "&lt;b&gt;sender&lt;/b&gt;");
    assert.include(html, "&lt;i&gt;contact&lt;/i&gt;");
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
