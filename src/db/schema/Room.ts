import { ListerId, RoomId } from "@/db/schema/brands"
import { Schema } from "effect"


export const RoomSchema = Schema.Struct({
  id: RoomId,
  listerId: ListerId,
  price: Schema.Number,
  location: Schema.String,
  description: Schema.NullishOr(Schema.String),
  size: Schema.NullishOr(Schema.Number),
  furnished: Schema.BooleanFromUnknown,
  ensuite: Schema.BooleanFromUnknown,
  smoking: Schema.BooleanFromUnknown,
  pets: Schema.BooleanFromUnknown,
  availableFrom: Schema.NullishOr(Schema.DateFromNumber),
  createdAt: Schema.DateFromNumber,
})

export const RoomFilters = RoomSchema.pick("price", "location", "size", "furnished", "ensuite", "smoking", "pets", "availableFrom")

export const UpdateRoomSchema = RoomSchema.pick('price', 'location', 'description', 'size', 'furnished', 'ensuite', 'smoking', 'pets', 'availableFrom')

export const RoomPhoto = Schema.Struct({
  id: Schema.Number,
  roomId: RoomId,
  url: Schema.String,
  position: Schema.Number,
})
