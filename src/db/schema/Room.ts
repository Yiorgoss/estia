import { ListerId, RoomId } from "@/db/schema/brands";
import { Schema, Struct } from "effect";

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
});

export const CreateRoomSchema = RoomSchema.mapFields(Struct.omit(["id", "createdAt"]));
export const CreateRoomBodySchema = CreateRoomSchema.mapFields(Struct.omit(["listerId"]));

export const RoomFilters = RoomSchema.mapFields(
  Struct.pick([
    "price",
    "location",
    "size",
    "furnished",
    "ensuite",
    "smoking",
    "pets",
    "availableFrom",
  ]),
).mapFields(Struct.map(Schema.optional));

// Search filters describe ranges rather than exact values: price and size are
// inclusive bounds, the bit flags filter on their exact value (a `false` flag
// is a real filter), and `availableFrom` means "available on or after".
export const RoomSearchFilters = Schema.Struct({
  minPrice: Schema.optional(Schema.Number),
  maxPrice: Schema.optional(Schema.Number),
  minSize: Schema.optional(Schema.Number),
  maxSize: Schema.optional(Schema.Number),
  furnished: Schema.optional(Schema.Boolean),
  ensuite: Schema.optional(Schema.Boolean),
  smoking: Schema.optional(Schema.Boolean),
  pets: Schema.optional(Schema.Boolean),
  availableFrom: Schema.optional(Schema.Date),
});

export const UpdateRoomSchema = RoomSchema.mapFields(
  Struct.pick([
    "price",
    "location",
    "description",
    "size",
    "furnished",
    "ensuite",
    "smoking",
    "pets",
    "availableFrom",
  ]),
);

export const RoomPhoto = Schema.Struct({
  id: Schema.Number,
  roomId: RoomId,
  url: Schema.String,
  position: Schema.Number,
});
