import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { RoomRepositoryLive } from "@/repos/room.repo";
import { RoomSearchService, RoomSearchServiceLive } from "@/services/room-search.service";
import { TestSqlLive } from "../support/sql";
import { insertLister, insertRoom, insertUser } from "../support/seed";

const RepositoriesLive = RoomRepositoryLive.pipe(Layer.provide(TestSqlLive));

const TestLive = Layer.merge(
  RoomSearchServiceLive.pipe(Layer.provide(RepositoriesLive)),
  TestSqlLive,
);

const seedLister = (id: number, userId: string) =>
  Effect.gen(function* () {
    yield* insertUser(userId, `${userId}@test.local`, "lister");
    yield* insertLister(id, userId);
  });

// Every test shares one database, so a filter can match rooms seeded by the
// other tests. Restricting the result to the current fixture's ids keeps each
// assertion about the rooms it seeded.
const fixtureIdsIn = (
  rooms: ReadonlyArray<{ readonly id: number }>,
  fixtureIds: ReadonlyArray<number>,
) =>
  rooms
    .map((room) => room.id)
    .filter((id) => fixtureIds.includes(id))
    .sort((a, b) => a - b);

layer(TestLive, { concurrent: false })("RoomSearchService", (it) => {
  it.effect("filters by inclusive price bounds", () =>
    Effect.gen(function* () {
      yield* seedLister(300, "u-search-price");
      yield* insertRoom(3000, 300, { price: 10400 });
      yield* insertRoom(3001, 300, { price: 10600 });
      yield* insertRoom(3002, 300, { price: 10800 });
      const fixtureIds = [3000, 3001, 3002];

      const service = yield* RoomSearchService;

      const minOnly = yield* service.search({ minPrice: 10600 });
      assert.deepStrictEqual(fixtureIdsIn(minOnly, fixtureIds), [3001, 3002]);

      const maxOnly = yield* service.search({ maxPrice: 10600 });
      assert.deepStrictEqual(fixtureIdsIn(maxOnly, fixtureIds), [3000, 3001]);

      const both = yield* service.search({ minPrice: 10600, maxPrice: 10800 });
      assert.deepStrictEqual(fixtureIdsIn(both, fixtureIds), [3001, 3002]);

      const inclusiveBoundary = yield* service.search({ minPrice: 10400, maxPrice: 10400 });
      assert.deepStrictEqual(fixtureIdsIn(inclusiveBoundary, fixtureIds), [3000]);

      const inverted = yield* service.search({ minPrice: 10800, maxPrice: 10400 });
      assert.deepStrictEqual(fixtureIdsIn(inverted, fixtureIds), []);
    }),
  );

  it.effect("filters by inclusive size bounds and excludes rooms without a size", () =>
    Effect.gen(function* () {
      yield* seedLister(301, "u-search-size");
      yield* insertRoom(3010, 301, { size: 1010 });
      yield* insertRoom(3011, 301, { size: 1025 });
      yield* insertRoom(3012, 301, { size: 1040 });
      yield* insertRoom(3013, 301, { size: null });
      const fixtureIds = [3010, 3011, 3012, 3013];

      const service = yield* RoomSearchService;

      const minOnly = yield* service.search({ minSize: 1025 });
      assert.deepStrictEqual(fixtureIdsIn(minOnly, fixtureIds), [3011, 3012]);

      const maxOnly = yield* service.search({ maxSize: 1025 });
      assert.deepStrictEqual(fixtureIdsIn(maxOnly, fixtureIds), [3010, 3011]);

      const both = yield* service.search({ minSize: 1010, maxSize: 1025 });
      assert.deepStrictEqual(fixtureIdsIn(both, fixtureIds), [3010, 3011]);

      const inclusiveBoundary = yield* service.search({ minSize: 1040, maxSize: 1040 });
      assert.deepStrictEqual(fixtureIdsIn(inclusiveBoundary, fixtureIds), [3012]);

      const inverted = yield* service.search({ minSize: 1040, maxSize: 1010 });
      assert.deepStrictEqual(fixtureIdsIn(inverted, fixtureIds), []);
    }),
  );

  it.effect("treats false bit filters as real filters", () =>
    Effect.gen(function* () {
      yield* seedLister(302, "u-search-bits");
      yield* insertRoom(3020, 302, { furnished: true, ensuite: true, smoking: true, pets: true });
      yield* insertRoom(3021, 302, {
        furnished: false,
        ensuite: false,
        smoking: false,
        pets: false,
      });
      yield* insertRoom(3022, 302, { furnished: true, ensuite: false, smoking: false, pets: true });
      yield* insertRoom(3023, 302, { furnished: false, ensuite: true, smoking: true, pets: false });
      const fixtureIds = [3020, 3021, 3022, 3023];

      const service = yield* RoomSearchService;

      const furnished = yield* service.search({ furnished: true });
      assert.deepStrictEqual(fixtureIdsIn(furnished, fixtureIds), [3020, 3022]);
      assert.strictEqual(furnished.find((room) => room.id === 3020)?.furnished, true);

      const notFurnished = yield* service.search({ furnished: false });
      assert.deepStrictEqual(fixtureIdsIn(notFurnished, fixtureIds), [3021, 3023]);
      assert.strictEqual(notFurnished.find((room) => room.id === 3021)?.furnished, false);

      const ensuite = yield* service.search({ ensuite: true });
      assert.deepStrictEqual(fixtureIdsIn(ensuite, fixtureIds), [3020, 3023]);

      const notEnsuite = yield* service.search({ ensuite: false });
      assert.deepStrictEqual(fixtureIdsIn(notEnsuite, fixtureIds), [3021, 3022]);

      const smoking = yield* service.search({ smoking: true });
      assert.deepStrictEqual(fixtureIdsIn(smoking, fixtureIds), [3020, 3023]);

      const notSmoking = yield* service.search({ smoking: false });
      assert.deepStrictEqual(fixtureIdsIn(notSmoking, fixtureIds), [3021, 3022]);

      const pets = yield* service.search({ pets: true });
      assert.deepStrictEqual(fixtureIdsIn(pets, fixtureIds), [3020, 3022]);

      const notPets = yield* service.search({ pets: false });
      assert.deepStrictEqual(fixtureIdsIn(notPets, fixtureIds), [3021, 3023]);
    }),
  );

  it.effect("filters rooms available on or after a date and excludes unknown availability", () =>
    Effect.gen(function* () {
      yield* seedLister(303, "u-search-available");
      yield* insertRoom(3030, 303, { availableFrom: 946684800000 });
      yield* insertRoom(3031, 303, { availableFrom: null });
      yield* insertRoom(3032, 303, { availableFrom: 978307200000 });
      const fixtureIds = [3030, 3031, 3032];

      const service = yield* RoomSearchService;

      const fromFirst = yield* service.search({ availableFrom: new Date(946684800000) });
      assert.deepStrictEqual(fixtureIdsIn(fromFirst, fixtureIds), [3030, 3032]);
      const earliest = fromFirst.find((room) => room.id === 3030);
      assert.instanceOf(earliest?.availableFrom, Date);
      assert.strictEqual(earliest?.availableFrom?.getTime(), 946684800000);

      const fromSecond = yield* service.search({ availableFrom: new Date(978307200000) });
      assert.deepStrictEqual(fixtureIdsIn(fromSecond, fixtureIds), [3032]);

      const fromFuture = yield* service.search({ availableFrom: new Date(1_600_000_000_000) });
      assert.deepStrictEqual(fixtureIdsIn(fromFuture, fixtureIds), []);
    }),
  );

  it.effect("combines a bit flag, a numeric bound, and availableFrom", () =>
    Effect.gen(function* () {
      yield* seedLister(304, "u-search-combination");
      yield* insertRoom(3040, 304, { furnished: true, price: 12700, availableFrom: 978307200000 });
      yield* insertRoom(3041, 304, { furnished: true, price: 12700, availableFrom: null });
      yield* insertRoom(3042, 304, { furnished: false, price: 12700, availableFrom: 978307200000 });
      yield* insertRoom(3043, 304, { furnished: true, price: 12300, availableFrom: 978307200000 });
      yield* insertRoom(3044, 304, { furnished: true, price: 13100, availableFrom: 978307200000 });
      yield* insertRoom(3045, 304, { furnished: true, price: 12700, availableFrom: 946684800000 });
      const fixtureIds = [3040, 3041, 3042, 3043, 3044, 3045];

      const service = yield* RoomSearchService;
      const results = yield* service.search({
        furnished: true,
        minPrice: 12700,
        maxPrice: 13000,
        availableFrom: new Date(978307200000),
      });
      assert.deepStrictEqual(fixtureIdsIn(results, fixtureIds), [3040]);

      const room = results.find((found) => found.id === 3040);
      assert.strictEqual(room?.furnished, true);
      assert.strictEqual(room?.availableFrom?.getTime(), 978307200000);
    }),
  );

  it.effect("returns an empty set when a combination matches nothing", () =>
    Effect.gen(function* () {
      yield* seedLister(305, "u-search-empty");
      yield* insertRoom(3050, 305, { furnished: true, price: 12700, size: 1100 });
      const fixtureIds = [3050];

      const service = yield* RoomSearchService;
      const results = yield* service.search({
        pets: true,
        minSize: 9000,
        maxSize: 9100,
        availableFrom: new Date(946684800000),
      });
      assert.deepStrictEqual(fixtureIdsIn(results, fixtureIds), []);
    }),
  );

  it.effect("an empty filter object returns every room", () =>
    Effect.gen(function* () {
      yield* seedLister(306, "u-search-everything");
      yield* insertRoom(3060, 306, {
        price: 9100,
        size: 9000,
        furnished: true,
        availableFrom: 946684800000,
      });
      yield* insertRoom(3061, 306);

      const service = yield* RoomSearchService;
      const sql = yield* SqlClient.SqlClient;
      const rooms = yield* service.search({});
      const [counted] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM rooms`;

      assert.strictEqual(rooms.length, counted.total);
      assert.isTrue(rooms.some((room) => room.id === 3060));
      assert.isTrue(rooms.some((room) => room.id === 3061));

      const plain = rooms.find((room) => room.id === 3061);
      assert.isNull(plain?.size);
      assert.isNull(plain?.availableFrom);
      assert.strictEqual(plain?.furnished, false);
    }),
  );
});
