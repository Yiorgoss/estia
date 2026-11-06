import { ListerId, RoomId } from "@/db/schema/brands";
import { BooleanFromString, NonBlankFiniteFromString } from "@/db/schema/codecs";
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

// Price and size are non-negative quantities, so a negative bound is rejected
// as a malformed request instead of being forwarded as a filter.
const NonNegativeFiniteFromString = NonBlankFiniteFromString.check(
  Schema.isGreaterThanOrEqualTo(0),
);

// The same filters as they travel over HTTP: query parameters are strings, so
// every field carries a string codec even though the decoded type stays
// identical to `RoomSearchFilters`. Numeric bounds go through
// `NonNegativeFiniteFromString` so a blank, non-numeric, non-finite, or
// negative value is a bad request instead of a filter that silently matches
// nothing, and a range whose minimum is above its maximum is a bad request
// rather than a query that happens to match nothing.
export const RoomSearchQuery = Schema.Struct({
  minPrice: Schema.optional(NonNegativeFiniteFromString),
  maxPrice: Schema.optional(NonNegativeFiniteFromString),
  minSize: Schema.optional(NonNegativeFiniteFromString),
  maxSize: Schema.optional(NonNegativeFiniteFromString),
  furnished: Schema.optional(BooleanFromString),
  ensuite: Schema.optional(BooleanFromString),
  smoking: Schema.optional(BooleanFromString),
  pets: Schema.optional(BooleanFromString),
  availableFrom: Schema.optional(Schema.DateFromString),
}).check(
  Schema.makeFilter((query) => {
    const issues: Array<Schema.FilterIssue> = [];
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      issues.push({ path: ["minPrice"], issue: "minPrice must not be greater than maxPrice" });
    }
    if (
      query.minSize !== undefined &&
      query.maxSize !== undefined &&
      query.minSize > query.maxSize
    ) {
      issues.push({ path: ["minSize"], issue: "minSize must not be greater than maxSize" });
    }
    return issues;
  }),
);

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
