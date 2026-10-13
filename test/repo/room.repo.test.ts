import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { ListerId, RoomId } from "@/db/schema/brands"
import { RoomRepository, RoomRepositoryLive } from "@/repo/room.repo"
import { TestSqlLive } from "../support/sql"
import { insertLister, insertRoom, insertUser } from "../support/seed"

const listerId = (value: number) => Schema.decodeSync(ListerId)(value)
const roomId = (value: number) => Schema.decodeSync(RoomId)(value)

const TestLive = Layer.merge(
  RoomRepositoryLive.pipe(Layer.provide(TestSqlLive)),
  TestSqlLive,
)

const seedLister = (id: number, userId: string) =>
  Effect.gen(function*() {
    yield* insertUser(userId, `${userId}@test.local`, "lister")
    yield* insertLister(id, userId)
  })

layer(TestLive, { concurrent: false })("RoomRepository", (it) => {
  it.effect("findAllByListerId returns every room for the lister", () =>
    Effect.gen(function*() {
      yield* seedLister(200, "u-room-multi")
      yield* seedLister(201, "u-room-single")
      yield* insertRoom(2000, 200, { price: 500, location: "MultiTown" })
      yield* insertRoom(2001, 200, { price: 700, location: "MultiTown" })
      yield* insertRoom(2002, 200, { price: 900, location: "MultiTown" })
      yield* insertRoom(2010, 201, { price: 450, location: "MultiTown" })

      const repo = yield* RoomRepository
      const multi = yield* repo.findAllByListerId(listerId(200))
      assert.strictEqual(multi.length, 3)
      assert.deepStrictEqual(multi.map((room) => room.id).sort(), [2000, 2001, 2002])

      const single = yield* repo.findAllByListerId(listerId(201))
      assert.strictEqual(single.length, 1)
      assert.strictEqual(single[0].id, 2010)
    }))

  it.effect("findByRoomId decodes bits and dates, and returns None otherwise", () =>
    Effect.gen(function*() {
      yield* seedLister(202, "u-room-by-id")
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
      })

      const repo = yield* RoomRepository
      const found = yield* repo.findByRoomId(roomId(2020))
      assert.isTrue(Option.isSome(found))
      const room = Option.getOrThrow(found)
      assert.strictEqual(room.listerId, 202)
      assert.strictEqual(room.price, 650)
      assert.strictEqual(room.location, "ByIdTown")
      assert.strictEqual(room.description, "sunny room")
      assert.strictEqual(room.size, 33)
      assert.strictEqual(room.furnished, true)
      assert.strictEqual(room.ensuite, false)
      assert.strictEqual(room.smoking, true)
      assert.strictEqual(room.pets, true)
      assert.instanceOf(room.availableFrom, Date)
      assert.strictEqual(room.availableFrom?.getTime(), 946684800000)
      assert.instanceOf(room.createdAt, Date)

      const missing = yield* repo.findByRoomId(roomId(99999))
      assert.isTrue(Option.isNone(missing))
    }))

  it.effect("findWithFilters matches value fields within a location", () =>
    Effect.gen(function*() {
      yield* seedLister(203, "u-room-values")
      yield* insertRoom(2030, 203, { price: 500, size: 20, location: "ValueTown", description: "a" })
      yield* insertRoom(2031, 203, { price: 700, size: 35, location: "ValueTown", description: "b" })
      yield* insertRoom(2032, 203, { price: 500, size: 20, location: "ValueTown", description: "c" })

      const repo = yield* RoomRepository
      const all = yield* repo.findWithFilters({ location: "ValueTown" })
      assert.strictEqual(all.length, 3)

      const byPrice = yield* repo.findWithFilters({ location: "ValueTown", price: 500 })
      assert.deepStrictEqual(byPrice.map((room) => room.id).sort(), [2030, 2032])

      const bySize = yield* repo.findWithFilters({ location: "ValueTown", size: 35 })
      assert.strictEqual(bySize.length, 1)
      assert.strictEqual(bySize[0].id, 2031)
    }))

  it.effect("findWithFilters treats false as a real bit filter, not an absent filter", () =>
    Effect.gen(function*() {
      yield* seedLister(204, "u-room-bits")
      yield* insertRoom(2040, 204, { location: "BitTown", furnished: true, pets: true, ensuite: true, smoking: true })
      yield* insertRoom(2041, 204, { location: "BitTown", furnished: false, pets: false, ensuite: false, smoking: false })
      yield* insertRoom(2042, 204, { location: "BitTown", furnished: true, pets: false, ensuite: false, smoking: false })

      const repo = yield* RoomRepository
      const furnished = yield* repo.findWithFilters({ location: "BitTown", furnished: true })
      assert.deepStrictEqual(furnished.map((room) => room.id).sort(), [2040, 2042])

      const notFurnished = yield* repo.findWithFilters({ location: "BitTown", furnished: false })
      assert.deepStrictEqual(notFurnished.map((room) => room.id), [2041])

      const withPets = yield* repo.findWithFilters({ location: "BitTown", pets: true })
      assert.deepStrictEqual(withPets.map((room) => room.id), [2040])

      const noPets = yield* repo.findWithFilters({ location: "BitTown", pets: false })
      assert.deepStrictEqual(noPets.map((room) => room.id).sort(), [2041, 2042])

      const ensuite = yield* repo.findWithFilters({ location: "BitTown", ensuite: true })
      assert.deepStrictEqual(ensuite.map((room) => room.id), [2040])

      const smoking = yield* repo.findWithFilters({ location: "BitTown", smoking: true })
      assert.deepStrictEqual(smoking.map((room) => room.id), [2040])
    }))

  it.effect("findWithFilters compares availableFrom as epoch millis", () =>
    Effect.gen(function*() {
      yield* seedLister(205, "u-room-dates")
      yield* insertRoom(2050, 205, { location: "DateTown", availableFrom: 946684800000 })
      yield* insertRoom(2051, 205, { location: "DateTown", availableFrom: null })
      yield* insertRoom(2052, 205, { location: "DateTown", availableFrom: 978307200000 })

      const repo = yield* RoomRepository
      const from2001 = yield* repo.findWithFilters({
        location: "DateTown",
        availableFrom: new Date(978307200000),
      })
      assert.deepStrictEqual(from2001.map((room) => room.id), [2052])
      assert.strictEqual(from2001[0].availableFrom?.getTime(), 978307200000)

      const all = yield* repo.findWithFilters({ location: "DateTown" })
      assert.strictEqual(all.length, 3)
      assert.isNull(all.find((room) => room.id === 2051)?.availableFrom)
    }))

  it.effect("findWithFilters ignores nullish filter values", () =>
    Effect.gen(function*() {
      yield* seedLister(206, "u-room-nullish")
      yield* insertRoom(2060, 206, { location: "NullTown" })

      const repo = yield* RoomRepository
      const filtered = yield* repo.findWithFilters({
        size: null,
        availableFrom: null,
      })
      assert.isTrue(filtered.some((room) => room.id === 2060))

      const all = yield* repo.findWithFilters({})
      assert.isTrue(all.some((room) => room.id === 2060))
    }))

  it.effect("updateRoom persists changes and returns the updated row", () =>
    Effect.gen(function*() {
      yield* seedLister(207, "u-room-update")
      yield* insertRoom(2070, 207, { price: 500, location: "BeforeTown", furnished: false })

      const repo = yield* RoomRepository
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
      })
      assert.isTrue(Option.isSome(updated))
      const room = Option.getOrThrow(updated)
      assert.strictEqual(room.price, 777)
      assert.strictEqual(room.location, "AfterTown")
      assert.strictEqual(room.description, "updated desc")
      assert.strictEqual(room.size, 42)
      assert.strictEqual(room.furnished, false)
      assert.strictEqual(room.ensuite, true)
      assert.strictEqual(room.smoking, false)
      assert.strictEqual(room.pets, true)
      assert.strictEqual(room.availableFrom?.getTime(), 1_600_000_000_000)

      const reread = Option.getOrThrow(yield* repo.findByRoomId(roomId(2070)))
      assert.strictEqual(reread.price, 777)
      assert.strictEqual(reread.location, "AfterTown")
      assert.strictEqual(reread.pets, true)
    }))

  it.effect("updateRoom stores SQL NULL for nullish values", () =>
    Effect.gen(function*() {
      yield* seedLister(208, "u-room-null-update")
      yield* insertRoom(2080, 208, {
        location: "NullUpdateTown",
        description: "before",
        size: 12,
        availableFrom: 946684800000,
      })

      const repo = yield* RoomRepository
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
      )
      assert.isNull(updated.description)
      assert.isNull(updated.size)
      assert.isNull(updated.availableFrom)
      assert.strictEqual(updated.furnished, false)
      assert.strictEqual(updated.pets, false)
    }))

  it.effect("updateRoom returns None for an unknown id", () =>
    Effect.gen(function*() {
      const repo = yield* RoomRepository
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
      })
      assert.isTrue(Option.isNone(missing))
    }))
})
