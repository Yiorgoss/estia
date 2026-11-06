import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { RoomSearchQuery } from "@/db/schema/Room";

// `HttpApiEndpoint` decodes a request's query parameters through the
// string-tree codec of the declared schema, so these tests decode through the
// same codec: they cover exactly what a request runs into.
const decode = Schema.decodeUnknownResult(Schema.toCodecStringTree(RoomSearchQuery));

const assertRejected = (query: Record<string, string>) =>
  assert.isTrue(
    Result.isFailure(decode(query)),
    `expected ${JSON.stringify(query)} to be rejected`,
  );

describe("RoomSearchQuery", () => {
  it("decodes every supported filter from its string form", () => {
    const result = decode({
      minPrice: "500",
      maxPrice: "1500",
      minSize: "20",
      maxSize: "60",
      furnished: "true",
      ensuite: "false",
      smoking: "true",
      pets: "false",
      availableFrom: "2025-01-01T00:00:00.000Z",
    });

    assert.isTrue(Result.isSuccess(result));
    if (Result.isSuccess(result)) {
      assert.deepStrictEqual(result.success, {
        minPrice: 500,
        maxPrice: 1500,
        minSize: 20,
        maxSize: 60,
        furnished: true,
        ensuite: false,
        smoking: true,
        pets: false,
        availableFrom: new Date("2025-01-01T00:00:00.000Z"),
      });
    }
  });

  it("decodes an empty query to no filters", () => {
    const result = decode({});

    assert.isTrue(Result.isSuccess(result));
    if (Result.isSuccess(result)) {
      assert.deepStrictEqual(result.success, {});
    }
  });

  it("keeps an explicit false boolean as a real filter", () => {
    const result = decode({
      furnished: "false",
      ensuite: "false",
      smoking: "false",
      pets: "false",
    });

    assert.isTrue(Result.isSuccess(result));
    if (Result.isSuccess(result)) {
      assert.deepStrictEqual(result.success, {
        furnished: false,
        ensuite: false,
        smoking: false,
        pets: false,
      });
    }
  });

  it("accepts equal range bounds", () => {
    const result = decode({ minPrice: "500", maxPrice: "500", minSize: "20", maxSize: "20" });

    assert.isTrue(Result.isSuccess(result));
    if (Result.isSuccess(result)) {
      assert.deepStrictEqual(result.success, {
        minPrice: 500,
        maxPrice: 500,
        minSize: 20,
        maxSize: 20,
      });
    }
  });

  it("rejects a blank, non-numeric, or non-finite bound", () => {
    assertRejected({ minPrice: "abc" });
    assertRejected({ maxPrice: "" });
    assertRejected({ maxPrice: " " });
    assertRejected({ minSize: "Infinity" });
    assertRejected({ maxSize: "NaN" });
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

  it("rejects a negative bound", () => {
    assertRejected({ minPrice: "-1" });
    assertRejected({ maxPrice: "-500" });
    assertRejected({ minSize: "-0.5" });
    assertRejected({ maxSize: "-20" });
  });

  it("rejects an inverted price range", () => {
    assertRejected({ minPrice: "1500", maxPrice: "500" });
  });

  it("rejects an inverted size range", () => {
    assertRejected({ minSize: "60", maxSize: "20" });
  });
});
