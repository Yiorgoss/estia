import { approximateLocation } from "@/db/schema/ListingPin";
import { asObject, call, callWithConfig, register, send } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * `GET /api/listings/map`, driven through the real public router against the
 * in-memory database. The endpoint is the first public surface that publishes a
 * location at all, so these tests pin the whole contract: published-only,
 * coordinate-required, room-wanted excluded, the feed's filter vocabulary, a
 * bounded newest-first set, and a wire object that carries nothing but a
 * rounded pin.
 */

const owner = await Effect.runPromise(register("map-owner"));

const publicPinKeys = [
  "currency",
  "id",
  "kind",
  "lat",
  "lng",
  "priceMinor",
  "regionCode",
  "sizeSqm",
  "title",
];

// Every fixture group gets its own price band, so a query can only match the
// rows the test created - earlier tests in the file never leak into a later one.
let priceCounter = 0;
const uniquePriceMinor = () => 700_000 + (priceCounter += 1) * 1013;

const create = (overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/listings", {
      cookie: owner.cookie,
      payload: {
        kind: "room",
        title: "Map listing",
        priceMinor: uniquePriceMinor(),
        regionCode: "attica",
        lat: 37.9838,
        lng: 23.7275,
        sizeSqm: 40,
        ...overrides,
      },
    });
    assert.strictEqual(response.status, 200, `create listing: ${response.body}`);
    return asObject(response.json);
  });

const publish = (id: unknown) =>
  Effect.gen(function* () {
    const response = yield* send("POST", `/api/listings/${String(id)}/publish`, {
      cookie: owner.cookie,
    });
    assert.strictEqual(response.status, 200, `publish listing: ${response.body}`);
  });

const publishNew = (overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const listing = yield* create(overrides);
    yield* publish(listing.id);
    return listing;
  });

const mapQuery = (params: Readonly<Record<string, string | number | boolean>> = {}) => {
  const search = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  ).toString();
  return call(`/api/listings/map${search === "" ? "" : `?${search}`}`);
};

const pinsOf = (response: { readonly json: unknown }): ReadonlyArray<Record<string, unknown>> => {
  const pins = asObject(response.json).pins;
  assert.isArray(pins);
  return pins as ReadonlyArray<Record<string, unknown>>;
};

const pinIds = (response: { readonly json: unknown }): ReadonlyArray<unknown> =>
  pinsOf(response).map((pin) => pin.id);

describe("GET /api/listings/map", () => {
  it.effect("serves only published listings with a coordinate, as rounded pins", () =>
    Effect.gen(function* () {
      const published = yield* publishNew({ title: "Published with a coordinate" });
      const draft = yield* create({ title: "Draft with a coordinate" });
      const unpublished = yield* publishNew({ title: "Unpublished with a coordinate" });
      yield* send("POST", `/api/listings/${String(unpublished.id)}/unlist`, {
        cookie: owner.cookie,
      });
      const coordinateLess = yield* publishNew({ lat: null, lng: null });

      const response = yield* mapQuery();
      assert.strictEqual(response.status, 200, response.body);

      const body = asObject(response.json);
      assert.deepStrictEqual(Object.keys(body).sort(), ["pins", "truncated"]);
      assert.isFalse(body.truncated);

      const pins = pinsOf(response);
      const ids = pins.map((pin) => pin.id);
      assert.include(ids, published.id);
      assert.notInclude(ids, draft.id, "a draft reached the map");
      assert.notInclude(ids, unpublished.id, "an unlisted listing reached the map");
      assert.notInclude(ids, coordinateLess.id, "a listing without a coordinate reached the map");

      const pin = pins.find((candidate) => candidate.id === published.id);
      assert.isDefined(pin);
      assert.deepStrictEqual(Object.keys(pin ?? {}).sort(), publicPinKeys);
      for (const key of [
        "ownerId",
        "status",
        "createdAt",
        "updatedAt",
        "publishedAt",
        "description",
      ]) {
        assert.isFalse(key in (pin ?? {}), `a map pin exposed ${key}`);
      }

      // The wire value is the rounded value - the stored pair appears nowhere.
      const rounded = approximateLocation(37.9838, 23.7275);
      assert.strictEqual(pin?.lat, rounded.lat);
      assert.strictEqual(pin?.lng, rounded.lng);
      assert.strictEqual(pin?.lat, 37.98);
      assert.notStrictEqual(pin?.lat, 37.9838);
      assert.strictEqual(pin?.currency, "EUR");
    }),
  );

  it.effect("answers the feed's whole filter vocabulary", () =>
    Effect.gen(function* () {
      const price = uniquePriceMinor();
      const attic = yield* publishNew({
        title: "Furnished attic",
        priceMinor: price,
        kind: "room",
        regionCode: "attica",
        sizeSqm: 30,
        furnished: 1,
        pets: 0,
        availableFrom: Date.UTC(2026, 2, 1),
      });
      const crete = yield* publishNew({
        title: "Cretan house",
        priceMinor: price,
        kind: "whole_property",
        regionCode: "crete",
        sizeSqm: 90,
        furnished: 0,
        pets: 1,
        availableFrom: null,
      });
      const band = { minPriceMinor: price, maxPriceMinor: price };

      const all = yield* mapQuery(band);
      assert.strictEqual(all.status, 200, all.body);
      assert.deepStrictEqual([...pinIds(all)].sort(), [attic.id, crete.id].sort());

      const rooms = yield* mapQuery({ ...band, kind: "room" });
      assert.deepStrictEqual(pinIds(rooms), [attic.id]);

      const cretan = yield* mapQuery({ ...band, regionCode: "crete" });
      assert.deepStrictEqual(pinIds(cretan), [crete.id]);

      const large = yield* mapQuery({ ...band, minSizeSqm: 90, maxSizeSqm: 90 });
      assert.deepStrictEqual(pinIds(large), [crete.id]);

      const small = yield* mapQuery({ ...band, maxSizeSqm: 30 });
      assert.deepStrictEqual(pinIds(small), [attic.id]);

      const furnished = yield* mapQuery({ ...band, furnished: true });
      assert.deepStrictEqual(pinIds(furnished), [attic.id]);

      const unfurnished = yield* mapQuery({ ...band, furnished: false });
      assert.deepStrictEqual(pinIds(unfurnished), [crete.id]);

      const petFriendly = yield* mapQuery({ ...band, pets: true });
      assert.deepStrictEqual(pinIds(petFriendly), [crete.id]);

      const fromMarch = yield* mapQuery({ ...band, availableFrom: "2026-03-01" });
      assert.deepStrictEqual(pinIds(fromMarch), [attic.id]);

      // The Cretan house has no availability date, and the attic is earlier
      // than April, so a later date matches neither.
      const fromApril = yield* mapQuery({ ...band, availableFrom: "2026-04-01" });
      assert.deepStrictEqual(pinIds(fromApril), []);
    }),
  );

  it.effect("bounds the set: newest first, a cap of 500, and an explicit truncated flag", () =>
    Effect.gen(function* () {
      const price = uniquePriceMinor();
      const first = yield* publishNew({ title: "First pinned", priceMinor: price });
      const second = yield* publishNew({ title: "Second pinned", priceMinor: price });
      const third = yield* publishNew({ title: "Third pinned", priceMinor: price });
      const band = { minPriceMinor: price, maxPriceMinor: price };

      const capped = yield* mapQuery({ ...band, limit: 2 });
      assert.strictEqual(capped.status, 200, capped.body);
      assert.isTrue(asObject(capped.json).truncated);
      assert.deepStrictEqual(pinIds(capped), [third.id, second.id]);

      const exact = yield* mapQuery({ ...band, limit: 3 });
      assert.strictEqual(exact.status, 200, exact.body);
      assert.isFalse(asObject(exact.json).truncated);
      assert.deepStrictEqual(pinIds(exact), [third.id, second.id, first.id]);

      const atCap = yield* mapQuery({ limit: 500 });
      assert.strictEqual(atCap.status, 200, atCap.body);

      const aboveCap = yield* mapQuery({ limit: 501 });
      assert.strictEqual(aboveCap.status, 400, aboveCap.body);

      const zero = yield* mapQuery({ limit: 0 });
      assert.strictEqual(zero.status, 400, zero.body);

      const malformed = yield* mapQuery({ limit: "lots" });
      assert.strictEqual(malformed.status, 400, malformed.body);
    }),
  );

  it.effect("never puts a room-wanted ad on the map", () =>
    Effect.gen(function* () {
      const price = uniquePriceMinor();
      const wanted = yield* publishNew({
        title: "Looking for a room",
        kind: "room_wanted",
        priceMinor: price,
      });
      const band = { minPriceMinor: price, maxPriceMinor: price };

      const all = yield* mapQuery(band);
      assert.strictEqual(all.status, 200, all.body);
      assert.notInclude(pinIds(all), wanted.id);

      // Asking for the kind directly cannot bypass the rule either.
      const explicit = yield* mapQuery({ ...band, kind: "room_wanted" });
      assert.strictEqual(explicit.status, 200, explicit.body);
      assert.deepStrictEqual(pinIds(explicit), []);
    }),
  );

  it.effect("rejects a malformed filter and an inverted range", () =>
    Effect.gen(function* () {
      const badNumber = yield* mapQuery({ minPriceMinor: "abc" });
      assert.strictEqual(badNumber.status, 400, badNumber.body);

      const badRegion = yield* mapQuery({ regionCode: "atlantis" });
      assert.strictEqual(badRegion.status, 400, badRegion.body);

      const inverted = yield* mapQuery({ minPriceMinor: 200, maxPriceMinor: 100 });
      assert.strictEqual(inverted.status, 400, inverted.body);
    }),
  );

  it.effect("is a literal route: /map is the map, /:id still opens a listing", () =>
    Effect.gen(function* () {
      const listing = yield* publishNew({ title: "Still reachable by id" });

      const map = yield* call("/api/listings/map");
      assert.strictEqual(map.status, 200, map.body);
      assert.isArray(asObject(map.json).pins);

      const detail = yield* call(`/api/listings/${String(listing.id)}`);
      assert.strictEqual(detail.status, 200, detail.body);
      assert.strictEqual(asObject(detail.json).id, listing.id);
    }),
  );

  it.effect("renders the map page with the archive PMTILES_GREECE names", () =>
    Effect.gen(function* () {
      const basemapUrlOf = (html: string): unknown => {
        const marker = html.indexOf('id="map-data">');
        const end = html.indexOf("</script>", marker);
        return JSON.parse(html.slice(html.indexOf(">", marker) + 1, end)).basemapUrl;
      };

      const configured = yield* callWithConfig(
        { PMTILES_GREECE: "/maps/custom-greece.pmtiles" },
        "/map",
      );
      assert.strictEqual(configured.status, 200, configured.body);
      assert.strictEqual(basemapUrlOf(configured.body), "/maps/custom-greece.pmtiles");

      const placeholder = yield* callWithConfig({}, "/map");
      assert.strictEqual(placeholder.status, 200, placeholder.body);
      assert.strictEqual(basemapUrlOf(placeholder.body), "/maps/greece.pmtiles");
    }),
  );
});
