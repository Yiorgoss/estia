import { ListerId, RoomId } from "@/db/schema/brands";
import { BooleanFromString } from "@/db/schema/codecs";
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

// The same filters as they travel over HTTP: query parameters are strings, so
// every field carries a string codec even though the decoded type stays
// identical to `RoomSearchFilters`. `FiniteFromString` is used instead of
// `NumberFromString` because the latter accepts `NaN` and `Infinity`, which
// would silently turn a typo into a filter that matches nothing.
export const RoomSearchQuery = Schema.Struct({
  minPrice: Schema.optional(Schema.FiniteFromString),
  maxPrice: Schema.optional(Schema.FiniteFromString),
  minSize: Schema.optional(Schema.FiniteFromString),
  maxSize: Schema.optional(Schema.FiniteFromString),
  furnished: Schema.optional(BooleanFromString),
  ensuite: Schema.optional(BooleanFromString),
  smoking: Schema.optional(BooleanFromString),
  pets: Schema.optional(BooleanFromString),
  availableFrom: Schema.optional(Schema.DateFromString),
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
