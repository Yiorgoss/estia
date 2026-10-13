import { ListerId, RoomId } from "@/db/schema/brands"
import { Schema, Struct } from "effect"


export const RoomSchema = Schema.Struct({
  id: RoomId,
  listerId: ListerId,
  price: Schema.Number,
  location: Schema.String,
  description: Schema.NullishOr(Schema.String),
  size: Schema.NullishOr(Schema.Number),
  furnished: Schema.BooleanFromBit,
  ensuite: Schema.BooleanFromBit,
  smoking: Schema.BooleanFromBit,
  pets: Schema.BooleanFromBit,
  availableFrom: Schema.NullishOr(Schema.DateFromMillis),
  createdAt: Schema.DateFromMillis,
})

export const RoomFilters = RoomSchema.mapFields(Struct.pick(["price", "location", "size", "furnished", "ensuite", "smoking", "pets", "availableFrom"]))

export const UpdateRoomSchema = RoomSchema.mapFields(Struct.pick(['price', 'location', 'description', 'size', 'furnished', 'ensuite', 'smoking', 'pets', 'availableFrom']))

export const RoomPhoto = Schema.Struct({
  id: Schema.Number,
  roomId: RoomId,
  url: Schema.String,
  position: Schema.Number,
})
