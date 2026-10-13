import { ListerId, RoomId, } from "@/db/schema/brands";
import { RoomFilters, RoomSchema, UpdateRoomSchema } from "@/db/schema/Room";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { Context, Effect, Layer, Option, Schema } from "effect";


export class RoomNotFoundError extends Schema.TaggedError<RoomNotFoundError>()(
  "RoomNotFoundError",
  { cause: Schema.String },
  { httpApiStatus: 404 },
) { }

export interface RoomRepository {
  readonly findAllByListerId: (listerId: typeof ListerId.Type) =>
    Effect.Effect<ReadonlyArray<typeof RoomSchema.Type>, SqlError>;
  readonly findByRoomId: (roomId: typeof RoomId.Type) =>
    Effect.Effect<Option.Option<typeof RoomSchema.Type>, SqlError>;
  readonly findWithFilters: (filters: typeof RoomFilters.Type) =>
    Effect.Effect<ReadonlyArray<typeof RoomSchema.Type>, SqlError>;
  readonly updateRoom: (roomId: typeof RoomId.Type, values: typeof UpdateRoomSchema.Type) =>
    Effect.Effect<Option.Option<typeof RoomSchema.Type>, SqlError>;
}

export const RoomRepository = Context.Service<RoomRepository>("RoomRepository");

const decodeRoom = (row: Record<string, unknown>): typeof RoomSchema.Type =>
  Schema.decodeUnknownSync(RoomSchema)(row)

// SQLite/D1 cannot bind a `Date`, so store the epoch milliseconds the
// `DateFromMillis` schema encodes to.
const toEpochMillis = (value: Date | null | undefined): number | null =>
  value instanceof Date ? value.getTime() : null

// `BooleanFromBit` is persisted as an integer flag.
const toBit = (value: boolean | null | undefined): number | null =>
  value == null ? null : value ? 1 : 0

export const RoomRepositoryLive = Layer.effect(
  RoomRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return {
      findAllByListerId: (listerId) =>
        sql<Record<string, unknown>> `
            SELECT *
              FROM rooms
             WHERE lister_id=${listerId}
            `
          .pipe(
            Effect.map(rows => rows.map(decodeRoom))
          ),
      findByRoomId: (roomId) =>
        sql<Record<string, unknown>> `
            SELECT *
              FROM rooms
             WHERE id=${roomId}
            `
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullishOr),
            Effect.map(Option.map(decodeRoom))
          ),
      findWithFilters: (filters) =>
        sql<Record<string, unknown>> `
            SELECT *
              FROM rooms
             WHERE 1=1
                 ${filters.price !== undefined ? sql`AND price = ${filters.price}` : sql``}
                 ${filters.location !== undefined ? sql`AND location = ${filters.location}` : sql``}
                 ${filters.size !== undefined ? sql`AND size = ${filters.size}` : sql``}
                 ${filters.furnished !== undefined ? sql`AND furnished = ${toBit(filters.furnished)}` : sql``}
                 ${filters.ensuite !== undefined ? sql`AND ensuite = ${toBit(filters.ensuite)}` : sql``}
                 ${filters.smoking !== undefined ? sql`AND smoking = ${toBit(filters.smoking)}` : sql``}
                 ${filters.pets !== undefined ? sql`AND pets = ${toBit(filters.pets)}` : sql``}
                 ${filters.availableFrom !== undefined ? sql`AND available_from >= ${toEpochMillis(filters.availableFrom)}` : sql``}
            `
          .pipe(
            Effect.map(rows => rows.map(decodeRoom))
          ),
      updateRoom: (roomId, { price, location, description, size, furnished, ensuite, smoking, pets, availableFrom }) =>
        sql<Record<string, unknown>> `
            UPDATE rooms
               SET ( price, location, description, size, furnished, ensuite, smoking, pets, available_from )
                 = (${price}, ${location}, ${description}, ${size}, ${toBit(furnished)}, ${toBit(ensuite)}, ${toBit(smoking)}, ${toBit(pets)}, ${toEpochMillis(availableFrom)})
             WHERE id=${roomId}
         RETURNING *;
            `
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullishOr),
            Effect.map(Option.map(decodeRoom))
          ),
    } satisfies RoomRepository // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError(error =>
      Effect.sync(() =>
        Effect.logError("Room repository failed", { error })
      )
    )
  )
)
