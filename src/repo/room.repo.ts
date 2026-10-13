import { ListerId, RoomId, } from "@/db/schema/brands";
import { RoomFilters, RoomSchema, UpdateRoomSchema } from "@/db/schema/Room";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { Context, Effect, Layer, Option, Schema } from "effect";


export class RoomNotFoundError extends Schema.TaggedError<RoomNotFoundError>()(
  "RoomNotFoundError",
  { cause: Schema.String },
) { }

export interface RoomRepository {
  readonly findAllByListerId: (listerId: typeof ListerId.Type) =>
    Effect.Effect<Option.Option<typeof RoomSchema.Type>, SqlError>;
  readonly findByRoomId: (roomId: typeof RoomId.Type) =>
    Effect.Effect<Option.Option<typeof RoomSchema.Type>, SqlError>;
  readonly updateRoom: (room: typeof RoomId.Type, values: typeof UpdateRoomSchema.Type) =>
    Effect.Effect<Option.Option<typeof RoomSchema.Type>, SqlError>;
  // readonly findWithFilters: (filters: typeof RoomFilters.Type) =>
  //   Effect.Effect<Option.Option<typeof RoomSchema.Type[]>, SqlError>
}

export const RoomRepository = Context.Service<RoomRepository>("RoomRepository");

export const RoomRepositoryLive = Layer.effect(
  RoomRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return {
      findAllByListerId: (listerId) =>
        sql<typeof RoomSchema.Type> `
            SELECT *
              FROM rooms
             WHERE lister_id=${listerId}
            `
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullishOr)
          ),
      findByRoomId: (roomId) =>
        sql<typeof RoomSchema.Type> `
            SELECT *
              FROM rooms
             WHERE id=${roomId}
            `
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullishOr)
          ),
      updateRoom: (roomId, { price, location, description: desc, size, furnished, ensuite, smoking, pets, availableFrom }) =>
        sql<typeof RoomSchema.Type> `
            UPDATE rooms
               SET ( price, location, description, size, furnished, ensuite, smoking, pets, availableFrom ) 
                 = (${price},${location}, ${desc}, ${size}, ${furnished}, ${ensuite}, ${smoking}, ${pets}, ${availableFrom})
              FROM rooms
             WHERE id=${roomId}
         RETURNING *;
            `
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullishOr)
          ),
      // findWithFilters: (filters) =>
      //   Effect.gen(function*() {
      //     return yield* sql<typeof RoomSchema.Type> `
      //       SELECT *
      //         FROM rooms
      //        WHERE 1=1
      //              ${filters.price !== undefined ? sql`AND price = ${filters.price}` : sql``}
      //              ${filters.location !== undefined ? sql`AND location = ${filters.location}` : sql``}
      //              ${filters.size !== undefined ? sql`AND size = ${filters.size}` : sql``}
      //              ${filters.furnished !== undefined ? sql`AND furnished = ${filters.furnished}` : sql``}
      //              ${filters.ensuite !== undefined ? sql`AND ensuite = ${filters.ensuite}` : sql``}
      //              ${filters.smoking !== undefined ? sql`AND smoking = ${filters.smoking}` : sql``}
      //              ${filters.pets !== undefined ? sql`AND pets = ${filters.pets}` : sql``}
      //              ${filters.availableFrom !== undefined ? sql`AND available_from >= ${filters.availableFrom}` : sql``}
      //     `
      //       .pipe(
      //         Effect.map(rows => rows[0]),
      //         Effect.map(Option.fromNullishOr)
      //       )
      //   })
    } satisfies RoomRepository // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError(error =>
      Effect.sync(() =>
        Effect.logError("Room repository failed", { error })
      )
    )
  )
)
