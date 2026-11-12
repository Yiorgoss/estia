import { ListingId, ListingPhotoId, UserId } from "@/db/schema/brands";
import type { ListingPhoto } from "@/db/schema/ListingPhoto";
import { ListingSchema } from "@/db/schema/Listing";
import {
  decodeCreateListingForm,
  decodeUpdateListingForm,
  listingFormValues,
  listingFormValuesFor,
} from "@/frontend/listing-form";
import { editListingPage, newListingPage } from "@/frontend/pages/listing-form";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

/*
 * The form decoder is the bridge between what a browser submits (strings) and
 * what the listing service takes (minor units, millis, bit flags). These tests
 * pin that conversion, the readable rejection messages, and the fact that the
 * pages only offer a status change that is legal from the current one.
 */

const form = (overrides: Record<string, string> = {}): Record<string, string> => ({
  kind: "room",
  title: "Sunny room near the port",
  description: "A quiet room with a balcony",
  price: "750",
  regionCode: "attica",
  sizeSqm: "30",
  availableFrom: "2026-03-01",
  furnished: "true",
  pets: "true",
  lat: "37.98",
  lng: "23.72",
  ...overrides,
});

describe("decodeCreateListingForm", () => {
  it("converts euros to minor units, keeps the date at UTC midnight, and turns flags into bits", () => {
    const result = decodeCreateListingForm(form());
    assert.isTrue(result.ok);
    if (!result.ok) return;

    assert.strictEqual(result.input.priceMinor, 75_000);
    assert.strictEqual(result.input.kind, "room");
    assert.strictEqual(result.input.regionCode, "attica");
    assert.strictEqual(result.input.sizeSqm, 30);
    assert.strictEqual(result.input.availableFrom?.getTime(), Date.UTC(2026, 2, 1));
    assert.strictEqual(result.input.furnished, true);
    assert.strictEqual(result.input.ensuite, false);
    assert.strictEqual(result.input.pets, true);
    assert.strictEqual(result.input.lat, 37.98);
  });

  it("treats blank optional fields as absent", () => {
    const result = decodeCreateListingForm(
      form({ description: "  ", sizeSqm: "", availableFrom: "", lat: "", lng: "" }),
    );
    assert.isTrue(result.ok);
    if (!result.ok) return;

    assert.isNull(result.input.description);
    assert.isNull(result.input.sizeSqm);
    assert.isNull(result.input.availableFrom);
    assert.isNull(result.input.lat);
    assert.isNull(result.input.lng);
  });

  it("rejects a blank and an oversized title with a readable message", () => {
    for (const title of ["   ", "x".repeat(121)]) {
      const result = decodeCreateListingForm(form({ title }));
      assert.isFalse(result.ok);
      if (result.ok) return;
      assert.match(result.message, /title/i);
    }
  });

  it("accepts up to two decimal places and converts them exactly to minor units", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["750", 75_000],
      ["45.5", 4_550],
      ["45.50", 4_550],
      ["0.05", 5],
      ["12.34", 1_234],
    ];
    for (const [price, expected] of cases) {
      const result = decodeCreateListingForm(form({ price }));
      assert.isTrue(result.ok, price);
      if (!result.ok) return;
      assert.strictEqual(result.input.priceMinor, expected, price);
    }
  });

  it("rejects a blank, non-numeric, negative, or over-precise price", () => {
    for (const price of ["", "abc", "-5", "12.", ".5", "12.345"]) {
      const result = decodeCreateListingForm(form({ price }));
      assert.isFalse(result.ok, `price ${JSON.stringify(price)}`);
      if (result.ok) return;
      assert.match(result.message, /price|euros/i);
    }
  });

  it("rejects half a coordinate pair", () => {
    for (const half of [{ lng: "" }, { lat: "" }]) {
      const result = decodeCreateListingForm(form(half));
      assert.isFalse(result.ok);
      if (result.ok) return;
      assert.match(result.message, /both latitude and longitude/);
    }
  });

  it("passes coordinates outside Greece through, so the service reports the 422", () => {
    const result = decodeCreateListingForm(form({ lat: "39.47", lng: "-0.38" }));
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.input.lat, 39.47);
    assert.strictEqual(result.input.lng, -0.38);
  });

  it("rejects an unavailable region or kind", () => {
    const badRegion = decodeCreateListingForm(form({ regionCode: "atlantis" }));
    assert.isFalse(badRegion.ok);
    const badKind = decodeCreateListingForm(form({ kind: "castle" }));
    assert.isFalse(badKind.ok);
  });
});

describe("decodeUpdateListingForm", () => {
  it("sends every field so a cleared box clears the stored value", () => {
    const result = decodeUpdateListingForm(
      form({ description: "", sizeSqm: "", availableFrom: "", lat: "", lng: "" }),
    );
    assert.isTrue(result.ok);
    if (!result.ok) return;

    assert.strictEqual(result.input.description, null);
    assert.strictEqual(result.input.sizeSqm, null);
    assert.strictEqual(result.input.availableFrom, null);
    assert.strictEqual(result.input.lat, null);
    assert.strictEqual(result.input.lng, null);
    assert.strictEqual(result.input.priceMinor, 75_000);
  });
});

const photo = (id: number, position: number, thumbnailKey: string | null = null): ListingPhoto => ({
  id: Schema.decodeSync(ListingPhotoId)(id),
  listingId: Schema.decodeSync(ListingId)(12),
  storageKey: `listings/12/photos/${id}.jpg`,
  contentType: "image/jpeg",
  byteSize: 3,
  thumbnailKey,
  position,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const listing = (overrides: Partial<typeof ListingSchema.Type>) => ({
  id: Schema.decodeSync(ListingId)(12),
  kind: "whole_property" as const,
  ownerId: Schema.decodeSync(UserId)("u-page-owner"),
  status: "draft" as const,
  title: "Two bedroom flat",
  description: "Sea view",
  priceMinor: 95_000,
  currency: "EUR" as const,
  regionCode: "crete" as const,
  lat: 35.34,
  lng: 25.13,
  sizeSqm: 74,
  availableFrom: new Date("2026-03-01T00:00:00.000Z"),
  furnished: true,
  ensuite: false,
  smoking: false,
  pets: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: null,
  ...overrides,
});

describe("listing pages", () => {
  it("prefills the edit form from the stored listing", () => {
    const values = listingFormValuesFor(listing({}));
    assert.strictEqual(values.kind, "whole_property");
    assert.strictEqual(values.priceEuros, "950");
    assert.strictEqual(values.sizeSqm, "74");
    assert.strictEqual(values.availableFrom, "2026-03-01");
    assert.isTrue(values.furnished);
    assert.strictEqual(values.lat, "35.34");
  });

  it("round-trips a stored price with cents through the edit form unchanged", () => {
    const values = listingFormValuesFor(listing({ priceMinor: 4_550 }));
    assert.strictEqual(values.priceEuros, "45.50");

    const result = decodeUpdateListingForm({
      title: values.title,
      description: values.description,
      price: values.priceEuros,
      regionCode: values.regionCode,
      sizeSqm: values.sizeSqm,
      availableFrom: values.availableFrom,
      furnished: values.furnished ? "true" : "",
      ensuite: values.ensuite ? "true" : "",
      smoking: values.smoking ? "true" : "",
      pets: values.pets ? "true" : "",
      lat: values.lat,
      lng: values.lng,
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.input.priceMinor, 4_550);
  });

  it("shows the stored kind when an edit is rejected without a kind field", () => {
    const stored = listing({ kind: "whole_property" });
    const submitted = listingFormValues({ title: "Renamed", price: "950" });
    assert.strictEqual(submitted.kind, "");

    const page = editListingPage(
      stored,
      submitted,
      "The title must be between 1 and 120 characters.",
    );
    assert.include(page, "Whole property");
    assert.include(page, "The title must be between 1 and 120 characters.");
  });

  it("escapes submitted values instead of rendering them as markup", () => {
    const page = newListingPage(listingFormValues(form({ title: "<script>x</script>" })));
    assert.notInclude(page, "<script>x</script>");
    assert.include(page, "&lt;script&gt;x&lt;/script&gt;");
  });

  it("offers only the legal status change for each status", () => {
    const draft = editListingPage(listing({ status: "draft" }), listingFormValuesFor(listing({})));
    assert.include(draft, "/listings/12/publish");
    assert.notInclude(draft, "/listings/12/unlist");

    const published = editListingPage(
      listing({ status: "published" }),
      listingFormValuesFor(listing({})),
    );
    assert.notInclude(published, "/listings/12/publish");
    assert.include(published, "/listings/12/unlist");

    const unpublished = editListingPage(
      listing({ status: "unpublished" }),
      listingFormValuesFor(listing({})),
    );
    assert.include(unpublished, "/listings/12/publish");
    assert.notInclude(unpublished, "/listings/12/unlist");
  });

  it("shows the gallery, its controls, and the upload form", () => {
    const page = editListingPage(listing({}), listingFormValuesFor(listing({})), undefined, [
      photo(101, 0),
      photo(102, 1),
    ]);

    assert.include(page, "Photos");
    assert.include(page, "2 of 10");
    assert.include(page, 'enctype="multipart/form-data"');
    assert.include(page, "multiple");
    // The first photo is labelled, not offered as its own promotion.
    assert.notInclude(page, "/listings/12/photos/101/first");
    assert.include(page, "/listings/12/photos/102/first");
    assert.include(page, "/listings/12/photos/101/move");
    assert.include(page, "/listings/12/photos/102/delete");
    // The preview grid reads the card image, not the full upload.
    assert.include(page, 'src="/listings/12/photos/101/card"');
  });

  it("shows which photos have no downscaled card image", () => {
    const missing = editListingPage(listing({}), listingFormValuesFor(listing({})), undefined, [
      photo(101, 0),
    ]);
    assert.include(missing, "No downscaled copy; the original is used on cards.");

    const present = editListingPage(listing({}), listingFormValuesFor(listing({})), undefined, [
      photo(102, 0, "listings/12/photos/102-card.webp"),
    ]);
    assert.notInclude(present, "No downscaled copy");
    assert.include(present, 'src="/listings/12/photos/102/card"');
  });

  it("explains an empty gallery and hides the upload form at the limit", () => {
    const empty = editListingPage(listing({}), listingFormValuesFor(listing({})), undefined, []);
    assert.include(empty, "No photos yet.");
    assert.include(empty, 'enctype="multipart/form-data"');

    const full = editListingPage(
      listing({}),
      listingFormValuesFor(listing({})),
      undefined,
      Array.from({ length: 10 }, (_, index) => photo(200 + index, index)),
    );
    assert.include(full, "10 of 10");
    assert.notInclude(full, 'enctype="multipart/form-data"');
  });

  it("shows the status and the reason a submit was rejected", () => {
    const page = editListingPage(
      listing({ status: "published" }),
      listingFormValuesFor(listing({})),
      "Those coordinates are outside Greece.",
    );
    assert.include(page, "Published");
    assert.include(page, "Those coordinates are outside Greece.");
  });
});
