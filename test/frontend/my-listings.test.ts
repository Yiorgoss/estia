import { ListingId, UserId } from "@/db/schema/brands";
import { encodeListingCursor, type ListingPage } from "@/db/schema/Listing";
import { myListingsPage } from "@/frontend/pages/my-listings";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

/*
 * The mine page has to show every status with the action that is legal from it,
 * page with the cursor the server handed out, and say something useful when the
 * owner has nothing yet. These tests pin that against the same fixtures the
 * create/edit page tests use.
 */

type MyListing = (typeof ListingPage.Type)["items"][number];

const listing = (overrides: Partial<MyListing> = {}): MyListing => ({
  id: Schema.decodeSync(ListingId)(1),
  kind: "room",
  ownerId: Schema.decodeSync(UserId)("u-mine-owner"),
  status: "draft",
  title: "Sunny room near the port",
  description: null,
  priceMinor: 75_000,
  currency: "EUR",
  regionCode: "attica",
  lat: null,
  lng: null,
  sizeSqm: 30,
  availableFrom: null,
  furnished: false,
  ensuite: false,
  smoking: false,
  pets: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: null,
  ...overrides,
});

const pageOf = (items: ReadonlyArray<MyListing>, nextCursor: MyListing["id"] | null = null) =>
  ({
    items,
    nextCursor: nextCursor === null ? null : { createdAt: 1_700_000_000_000, id: nextCursor },
  }) satisfies typeof ListingPage.Type;

const render = (page: typeof ListingPage.Type, selfHref = "/listings/mine") =>
  myListingsPage(page, { selfHref });

describe("myListingsPage", () => {
  it("shows every status with its badge and only the action that is legal from it", () => {
    const page = render(
      pageOf([
        listing({ id: Schema.decodeSync(ListingId)(11), status: "draft", title: "A draft" }),
        listing({ id: Schema.decodeSync(ListingId)(12), status: "published", title: "Published" }),
        listing({ id: Schema.decodeSync(ListingId)(13), status: "unpublished", title: "Unlisted" }),
      ]),
    );

    assert.include(page, "A draft");
    assert.include(page, "Draft");
    assert.include(page, "Published");
    assert.include(page, "Unlisted");
    assert.include(page, "Attica");
    assert.include(page, "Room");
    assert.include(page, "€750");

    // A draft can only be published, a published row can only be unlisted, and
    // an unlisted row can be published again.
    assert.include(page, 'action="/listings/11/publish"');
    assert.notInclude(page, 'action="/listings/11/unlist"');
    assert.include(page, 'action="/listings/12/unlist"');
    assert.notInclude(page, 'action="/listings/12/publish"');
    assert.include(page, 'action="/listings/13/publish"');
    assert.notInclude(page, 'action="/listings/13/unlist"');

    // Acting from this page comes back to this page, not to the edit form.
    assert.include(page, 'name="returnTo" value="/listings/mine"');
  });

  it("carries the current page in the action's return-to value", () => {
    const page = render(
      pageOf([listing({ status: "draft" })]),
      "/listings/mine?cursor=MTcwMDAwMDAwMDAwMDox",
    );

    assert.include(page, 'name="returnTo" value="/listings/mine?cursor=MTcwMDAwMDAwMDAwMDox"');
  });

  it("offers a next page that carries the server's cursor forward", () => {
    const cursorId = Schema.decodeSync(ListingId)(42);
    const page = render(pageOf([listing()], cursorId));

    const expected = encodeListingCursor({ createdAt: 1_700_000_000_000, id: cursorId });
    assert.include(page, `href="/listings/mine?cursor=${expected}"`);
    assert.include(page, "Next page");
  });

  it("has no next page when the server handed out no cursor", () => {
    const page = render(pageOf([listing()]));
    assert.notInclude(page, "Next page");
  });

  it("points an empty feed at the create form", () => {
    const page = render(pageOf([]));

    assert.include(page, "You have not posted a listing yet");
    assert.include(page, 'href="/listings/new"');
    assert.notInclude(page, "Showing 0 listings");
  });

  it("repeats a rejected action's message above the rows", () => {
    const page = myListingsPage(pageOf([listing()]), {
      selfHref: "/listings/mine",
      error: "That status change is not possible.",
    });

    assert.include(page, 'role="alert"');
    assert.include(page, "That status change is not possible.");
  });

  it("escapes a listing title instead of rendering it as markup", () => {
    const page = render(pageOf([listing({ title: "<script>x</script>" })]));

    assert.notInclude(page, "<script>x</script>");
    assert.include(page, "&lt;script&gt;x&lt;/script&gt;");
  });
});
