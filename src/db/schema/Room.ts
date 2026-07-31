import { Schema } from "effect"
import { ListerId } from "./Lister";

export const RoomId = Schema.Number.pipe(Schema.brand("RoomId"))

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
  availableFrom: Schema.DateFromNumber,
  createdAt: Schema.DateFromNumber,
})

export const RoomPhoto = Schema.Struct({
  id: Schema.Number,
  roomId: RoomId,
  url: Schema.String,
  position: Schema.Number,
})
