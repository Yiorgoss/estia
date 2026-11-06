import { ListingCursor, ListingCursorFromString, ListingSearchQuery } from "@/db/schema/Listing";
import { withMinorUnitPrices } from "@/utils";
import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";

// `HttpApiEndpoint` decodes a request's query parameters through the string-tree
// codec of the declared schema, so these tests decode through the same codec:
// they cover exactly what a request runs into.
const decode = Schema.decodeUnknownResult(Schema.toCodecStringTree(ListingSearchQuery));

const assertRejected = (query: Record<string, string>) =>
  assert.isTrue(
    Result.isFailure(decode(query)),
    `expected ${JSON.stringify(query)} to be rejected`,
  );

const assertDecoded = (
  query: Record<string, string>,
  expected: Partial<typeof ListingSearchQuery.Type>,
) => {
  const result = decode(query);
  assert.isTrue(Result.isSuccess(result), `expected ${JSON.stringify(query)} to be accepted`);
  if (Result.isSuccess(result)) {
    assert.deepStrictEqual(result.success, expected);
  }
};

describe("ListingSearchQuery", () => {
  it("decodes every supported filter from its string form", () => {
    assertDecoded(
      {
        kind: "whole_property",
        regionCode: "crete",
        minPriceMinor: "45000",
        maxPriceMinor: "150000",
        minSizeSqm: "20",
        maxSizeSqm: "60",
        furnished: "true",
        ensuite: "false",
        smoking: "true",
        pets: "false",
        availableFrom: "2025-01-01T00:00:00.000Z",
        limit: "12",
      },
      {
        kind: "whole_property",
        regionCode: "crete",
        minPriceMinor: 45_000,
        maxPriceMinor: 150_000,
        minSizeSqm: 20,
        maxSizeSqm: 60,
        furnished: true,
        ensuite: false,
        smoking: true,
        pets: false,
        availableFrom: new Date("2025-01-01T00:00:00.000Z"),
        limit: 12,
      },
    );
  });

  it("decodes every listing kind and region", () => {
    for (const kind of ["room", "whole_property", "room_wanted"] as const) {
      assertDecoded({ kind }, { kind, limit: 20 });
    }
    for (const regionCode of [
      "attica",
      "central_greece",
      "central_macedonia",
      "crete",
      "eastern_macedonia_and_thrace",
      "epirus",
      "ionian_islands",
      "north_aegean",
      "peloponnese",
      "south_aegean",
      "thessaly",
      "western_greece",
      "western_macedonia",
    ] as const) {
      assertDecoded({ regionCode }, { regionCode, limit: 20 });
    }
  });

  it("decodes an empty query to the default limit and no filters", () => {
    assertDecoded({}, { limit: 20 });
  });

  it("keeps an explicit false boolean as a real filter", () => {
    assertDecoded(
      { furnished: "false", ensuite: "false", smoking: "false", pets: "false" },
      { furnished: false, ensuite: false, smoking: false, pets: false, limit: 20 },
    );
  });

  it("accepts equal range bounds", () => {
    assertDecoded(
      { minPriceMinor: "45000", maxPriceMinor: "45000", minSizeSqm: "20", maxSizeSqm: "20" },
      {
        minPriceMinor: 45_000,
        maxPriceMinor: 45_000,
        minSizeSqm: 20,
        maxSizeSqm: 20,
        limit: 20,
      },
    );
  });

  it("defaults the limit to 20 and accepts up to 50", () => {
    assertDecoded({}, { limit: 20 });
    assertDecoded({ limit: "1" }, { limit: 1 });
    assertDecoded({ limit: "50" }, { limit: 50 });
  });

  it("rejects a limit above the cap, below one, or not an integer", () => {
    assertRejected({ limit: "51" });
    assertRejected({ limit: "0" });
    assertRejected({ limit: "-5" });
    assertRejected({ limit: "1.5" });
    assertRejected({ limit: "abc" });
    assertRejected({ limit: "" });
    assertRejected({ limit: " " });
    assertRejected({ limit: "Infinity" });
  });

  it("round-trips a cursor through its opaque string form", () => {
    const cursor = Schema.decodeSync(ListingCursor)({ createdAt: 1_700_000_000_123, id: 42 });
    const wire = Schema.encodeSync(ListingCursorFromString)(cursor);

    // Opaque: the sort key is not readable and no offset is representable.
    assert.strictEqual(wire, "MTcwMDAwMDAwMDEyMzo0Mg");
    assert.notInclude(wire, ":");

    const result = decode({ cursor: wire });
    assert.isTrue(Result.isSuccess(result));
    if (Result.isSuccess(result)) {
      assert.deepStrictEqual(result.success.cursor, cursor);
      assert.strictEqual(result.success.limit, 20);
    }
  });

  it("rejects a malformed cursor instead of ignoring it", () => {
    // Not base64url, or base64url of something that is not `createdAt:id`.
    for (const cursor of [
      "not-a-cursor",
      "abc",
      "",
      " ",
      "20",
      "offset=20",
      "MTIz", // "123"
      "MTIzOg", // "123:"
      "OjQy", // ":42"
      "MTIzOjQyOjU=", // "123:42:5" with padding
      "MS41OjQy", // "1.5:42"
      "YWJjOjQy", // "abc:42"
      "LTE6NDI", // "-1:42"
      "MTIzOjQyLjU", // "123:42.5"
    ]) {
      assertRejected({ cursor });
    }
  });

  it("ignores an invented offset parameter, so a caller cannot page by offset", () => {
    // Unknown query keys are dropped by the struct; there is no offset field for
    // a caller to page with.
    assertDecoded({ offset: "40" }, { limit: 20 });
  });

  it("rejects a blank, whitespace, non-numeric, or non-finite bound", () => {
    for (const field of ["minPriceMinor", "maxPriceMinor", "minSizeSqm", "maxSizeSqm"] as const) {
      assertRejected({ [field]: "" });
      assertRejected({ [field]: " " });
      assertRejected({ [field]: "abc" });
      assertRejected({ [field]: "Infinity" });
      assertRejected({ [field]: "NaN" });
    }
  });

  it("rejects a negative bound", () => {
    assertRejected({ minPriceMinor: "-1" });
    assertRejected({ maxPriceMinor: "-500" });
    assertRejected({ minSizeSqm: "-0.5" });
    assertRejected({ maxSizeSqm: "-20" });
  });

  it("rejects a fractional bound, since price minor units and size are integers", () => {
    assertRejected({ minPriceMinor: "45000.5" });
    assertRejected({ maxSizeSqm: "20.5" });
  });

  it("rejects an inverted price range", () => {
    assertRejected({ minPriceMinor: "150000", maxPriceMinor: "50000" });
  });

  it("rejects an inverted size range", () => {
    assertRejected({ minSizeSqm: "60", maxSizeSqm: "20" });
  });

  it("rejects an unknown region or kind", () => {
    assertRejected({ regionCode: "atlantis" });
    assertRejected({ regionCode: "Attica" });
    assertRejected({ regionCode: "" });
    assertRejected({ kind: "castle" });
    assertRejected({ kind: "ROOM" });
    assertRejected({ kind: "" });
  });

  it("rejects a boolean that is not true or false", () => {
    assertRejected({ furnished: "yes" });
    assertRejected({ ensuite: "1" });
    assertRejected({ smoking: "" });
    assertRejected({ pets: "TRUE" });
  });

  it("rejects an invalid available-from date", () => {
    assertRejected({ availableFrom: "not-a-date" });
    assertRejected({ availableFrom: "2025-13-45" });
  });
});

describe("withMinorUnitPrices", () => {
  it("converts whole-euro form prices to minor units", () => {
    assert.deepStrictEqual(withMinorUnitPrices({ minPrice: "500", maxPrice: "1500" }), {
      minPriceMinor: "50000",
      maxPriceMinor: "150000",
    });
    // A decimal euro value is still an exact integer in minor units.
    assert.deepStrictEqual(withMinorUnitPrices({ minPrice: "450.5" }), {
      minPriceMinor: "45050",
    });
  });

  it("drops empty values and leaves the other filters alone", () => {
    assert.deepStrictEqual(
      withMinorUnitPrices({ minPrice: "", minSizeSqm: "20", regionCode: "crete" }),
      { minSizeSqm: "20", regionCode: "crete" },
    );
  });

  it("passes a malformed price through so the query codec rejects it", () => {
    for (const minPrice of ["abc", " ", "Infinity"]) {
      assert.isTrue(
        Result.isFailure(decode(withMinorUnitPrices({ minPrice }))),
        `expected ${JSON.stringify(minPrice)} to be rejected`,
      );
    }
  });
});
