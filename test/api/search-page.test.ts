import { asObject, call, register, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The search page's results route, driven through the real router. The free-text
 * criterion is part of the search vocabulary, so this pins both of its ends: a
 * blank box is still the whole feed, and words in the box narrow it.
 */

const owner = await Effect.runPromise(register("search-page-owner"));

let priceCounter = 0;
const uniquePriceMinor = () => 900_000 + (priceCounter += 1) * 977;

const publish = (title: string) =>
  Effect.gen(function* () {
    const created = yield* send("POST", "/api/listings", {
      cookie: owner.cookie,
      payload: {
        kind: "room",
        title,
        priceMinor: uniquePriceMinor(),
        regionCode: "crete",
      },
    });
    assert.strictEqual(created.status, 200, `create listing: ${created.body}`);
    const id = asObject(created.json)["id"];
    const published = yield* send("POST", `/api/listings/${String(id)}/publish`, {
      cookie: owner.cookie,
    });
    assert.strictEqual(published.status, 200, `publish listing: ${published.body}`);
    return title;
  });

describe("GET /search/results", () => {
  it.effect("returns the whole feed for a blank query and narrows on matching words", () =>
    Effect.gen(function* () {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const balcony = yield* publish(`Balcony ${nonce} one`);
      const basement = yield* publish(`Basement ${nonce} two`);

      const blank = yield* call(`/search/results?query=${encodeURIComponent("   ")}`);
      assert.strictEqual(blank.status, 200, blank.body);
      assert.include(blank.body, balcony);
      assert.include(blank.body, basement);

      const noQuery = yield* call("/search/results");
      assert.strictEqual(noQuery.status, 200, noQuery.body);
      assert.include(noQuery.body, balcony);
      assert.include(noQuery.body, basement);

      const matching = yield* call(
        `/search/results?query=${encodeURIComponent(`${nonce} one`)}`,
      );
      assert.strictEqual(matching.status, 200, matching.body);
      assert.include(matching.body, balcony);
      assert.notInclude(matching.body, basement);
    }),
  );
});
