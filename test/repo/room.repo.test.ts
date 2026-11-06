import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { ListerId, RoomId } from "@/db/schema/brands";
import { RoomRepository, RoomRepositoryLive } from "@/repos/room.repo";
import { TestSqlLive } from "../support/sql";
import { insertLister, insertRoom, insertUser } from "../support/seed";

const listerId = (value: number) => Schema.decodeSync(ListerId)(value);
const roomId = (value: number) => Schema.decodeSync(RoomId)(value);

const TestLive = Layer.merge(RoomRepositoryLive.pipe(Layer.provide(TestSqlLive)), TestSqlLive);

const seedLister = (id: number, userId: string) =>
  Effect.gen(function* () {
    yield* insertUser(userId, `${userId}@test.local`, "lister");
    yield* insertLister(id, userId);
  });

layer(TestLive, { concurrent: false })("RoomRepository", (it) => {
  it.effect("findAllByListerId returns every room for the lister", () =>
    Effect.gen(function* () {
      yield* seedLister(200, "u-room-multi");
      yield* seedLister(201, "u-room-single");
      yield* insertRoom(2000, 200, { price: 500, location: "MultiTown" });
      yield* insertRoom(2001, 200, { price: 700, location: "MultiTown" });
      yield* insertRoom(2002, 200, { price: 900, location: "MultiTown" });
      yield* insertRoom(2010, 201, { price: 450, location: "MultiTown" });

      const repo = yield* RoomRepository;
      const multi = yield* repo.findAllByListerId(listerId(200));
      assert.strictEqual(multi.length, 3);
      assert.deepStrictEqual(multi.map((room) => room.id).sort(), [2000, 2001, 2002]);

      const single = yield* repo.findAllByListerId(listerId(201));
      assert.strictEqual(single.length, 1);
      assert.strictEqual(single[0].id, 2010);
    }),
  );

  it.effect("findByRoomId decodes bits and dates, and returns None otherwise", () =>
    Effect.gen(function* () {
      yield* seedLister(202, "u-room-by-id");
      yield* insertRoom(2020, 202, {
        price: 650,
        location: "ByIdTown",
        description: "sunny room",
        size: 33,
        furnished: true,
        ensuite: false,
        smoking: true,
        pets: true,
        availableFrom: 946684800000,
      });

      const repo = yield* RoomRepository;
      const found = yield* repo.findByRoomId(roomId(2020));
      assert.isTrue(Option.isSome(found));
      const room = Option.getOrThrow(found);
      assert.strictEqual(room.listerId, 202);
      assert.strictEqual(room.price, 650);
      assert.strictEqual(room.location, "ByIdTown");
      assert.strictEqual(room.description, "sunny room");
      assert.strictEqual(room.size, 33);
      assert.strictEqual(room.furnished, true);
      assert.strictEqual(room.ensuite, false);
      assert.strictEqual(room.smoking, true);
      assert.strictEqual(room.pets, true);
      assert.instanceOf(room.availableFrom, Date);
      assert.strictEqual(room.availableFrom?.getTime(), 946684800000);
      assert.instanceOf(room.createdAt, Date);

      const missing = yield* repo.findByRoomId(roomId(99999));
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("updateRoom persists changes and returns the updated row", () =>
    Effect.gen(function* () {
      yield* seedLister(207, "u-room-update");
      yield* insertRoom(2070, 207, { price: 500, location: "BeforeTown", furnished: false });

      const repo = yield* RoomRepository;
      const updated = yield* repo.updateRoom(roomId(2070), {
        price: 777,
        location: "AfterTown",
        description: "updated desc",
        size: 42,
        furnished: false,
        ensuite: true,
        smoking: false,
        pets: true,
        availableFrom: new Date(1_600_000_000_000),
      });
      assert.isTrue(Option.isSome(updated));
      const room = Option.getOrThrow(updated);
      assert.strictEqual(room.price, 777);
      assert.strictEqual(room.location, "AfterTown");
      assert.strictEqual(room.description, "updated desc");
      assert.strictEqual(room.size, 42);
      assert.strictEqual(room.furnished, false);
      assert.strictEqual(room.ensuite, true);
      assert.strictEqual(room.smoking, false);
      assert.strictEqual(room.pets, true);
      assert.strictEqual(room.availableFrom?.getTime(), 1_600_000_000_000);

      const reread = Option.getOrThrow(yield* repo.findByRoomId(roomId(2070)));
      assert.strictEqual(reread.price, 777);
      assert.strictEqual(reread.location, "AfterTown");
      assert.strictEqual(reread.pets, true);
    }),
  );

  it.effect("updateRoom stores SQL NULL for nullish values", () =>
    Effect.gen(function* () {
      yield* seedLister(208, "u-room-null-update");
      yield* insertRoom(2080, 208, {
        location: "NullUpdateTown",
        description: "before",
        size: 12,
        availableFrom: 946684800000,
      });

      const repo = yield* RoomRepository;
      const updated = Option.getOrThrow(
        yield* repo.updateRoom(roomId(2080), {
          price: 300,
          location: "NullUpdateTown",
          description: null,
          size: null,
          furnished: false,
          ensuite: false,
          smoking: false,
          pets: false,
          availableFrom: null,
        }),
      );
      assert.isNull(updated.description);
      assert.isNull(updated.size);
      assert.isNull(updated.availableFrom);
      assert.strictEqual(updated.furnished, false);
      assert.strictEqual(updated.pets, false);
    }),
  );

  it.effect("updateRoom returns None for an unknown id", () =>
    Effect.gen(function* () {
      const repo = yield* RoomRepository;
      const missing = yield* repo.updateRoom(roomId(99999), {
        price: 1,
        location: "Nowhere",
        description: null,
        size: null,
        furnished: false,
        ensuite: false,
        smoking: false,
        pets: false,
        availableFrom: null,
      });
      assert.isTrue(Option.isNone(missing));
    }),
  );
});
