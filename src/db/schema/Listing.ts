import { ListingId, UserId } from "@/db/schema/brands";
import { Effect, Schema } from "effect";

/*
 * One listing table covers all three kinds of ad, so every schema here is
 * kind-agnostic. Kind-specific attributes are not modeled yet: the four room
 * bits carry over unchanged and stay `false` for a room-wanted ad.
 */

export const ListingKind = Schema.Literals(["room", "whole_property", "room_wanted"]);
export type ListingKind = typeof ListingKind.Type;

export const ListingStatus = Schema.Literals(["draft", "published", "unpublished"]);
export type ListingStatus = typeof ListingStatus.Type;

/*
 * The 13 Greek administrative regions. `src/db/migrations/0004_listings.sql`
 * seeds the same codes into the `regions` table, whose FK is the integrity
 * guarantee; this literal is the decoding guarantee. `test/repo/listing.repo.test.ts`
 * pins the two sets together.
 */
export const GreekRegionCodes = [
  "attica",
  "central_greece",
  "central_macedonia",
  "crete",
  "eastern_macedonia_and_thrace",
  "epirus",
  "ionian_islands",
  "north_aegean",
  "peloponnese",
  "south_aegean",
  "thessaly",
  "western_greece",
  "western_macedonia",
] as const;
export type GreekRegionCode = (typeof GreekRegionCodes)[number];

export const GreekRegion = Schema.Literals(GreekRegionCodes);
export type GreekRegion = typeof GreekRegion.Type;

export const Currency = Schema.Literals(["EUR"]);
export type Currency = typeof Currency.Type;

/*
 * Coordinates are optional display data, never a boundary. The bounds below are
 * a coarse sanity box around Greece; the required region is the real location
 * gate. `packages/map/greece.json` is deliberately not wired into production
 * code (it accepts Izmir and Sarande and rejects Kastellorizo).
 */
export const GREEK_LATITUDE_RANGE = { minimum: 34.0, maximum: 42.5 } as const;
export const GREEK_LONGITUDE_RANGE = { minimum: 19.0, maximum: 30.5 } as const;

const Latitude = Schema.Number.check(Schema.isBetween(GREEK_LATITUDE_RANGE));
const Longitude = Schema.Number.check(Schema.isBetween(GREEK_LONGITUDE_RANGE));

export const ListingTitle = Schema.NonEmptyString.check(Schema.isMaxLength(120));
const ListingDescription = Schema.String.check(Schema.isMaxLength(5000));
const PriceMinor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SizeSqm = Schema.Int.check(Schema.isGreaterThan(0));

export const ListingSchema = Schema.Struct({
  id: ListingId,
  kind: ListingKind,
  ownerId: UserId,
  status: ListingStatus,
  title: Schema.String,
  description: Schema.NullishOr(Schema.String),
  priceMinor: Schema.Number,
  currency: Currency,
  regionCode: GreekRegion,
  lat: Schema.NullishOr(Schema.Number),
  lng: Schema.NullishOr(Schema.Number),
  sizeSqm: Schema.NullishOr(Schema.Number),
  availableFrom: Schema.NullishOr(Schema.DateFromMillis),
  furnished: Schema.BooleanFromBit,
  ensuite: Schema.BooleanFromBit,
  smoking: Schema.BooleanFromBit,
  pets: Schema.BooleanFromBit,
  createdAt: Schema.DateFromMillis,
  updatedAt: Schema.DateFromMillis,
  publishedAt: Schema.NullishOr(Schema.DateFromMillis),
});
export type Listing = typeof ListingSchema.Type;

export const CreateListingInput = Schema.Struct({
  kind: ListingKind,
  title: ListingTitle,
  description: Schema.optional(Schema.NullishOr(ListingDescription)),
  priceMinor: PriceMinor,
  regionCode: GreekRegion,
  lat: Schema.optional(Schema.NullishOr(Latitude)),
  lng: Schema.optional(Schema.NullishOr(Longitude)),
  sizeSqm: Schema.optional(Schema.NullishOr(SizeSqm)),
  availableFrom: Schema.optional(Schema.NullishOr(Schema.DateFromMillis)),
  furnished: Schema.optional(Schema.BooleanFromBit),
  ensuite: Schema.optional(Schema.BooleanFromBit),
  smoking: Schema.optional(Schema.BooleanFromBit),
  pets: Schema.optional(Schema.BooleanFromBit),
});
export type CreateListingInput = typeof CreateListingInput.Type;

// `kind` is deliberately not updatable: a listing does not change what it is.
export const UpdateListingInput = Schema.Struct({
  title: Schema.optional(ListingTitle),
  description: Schema.optional(Schema.NullishOr(ListingDescription)),
  priceMinor: Schema.optional(PriceMinor),
  regionCode: Schema.optional(GreekRegion),
  lat: Schema.optional(Schema.NullishOr(Latitude)),
  lng: Schema.optional(Schema.NullishOr(Longitude)),
  sizeSqm: Schema.optional(Schema.NullishOr(SizeSqm)),
  availableFrom: Schema.optional(Schema.NullishOr(Schema.DateFromMillis)),
  furnished: Schema.optional(Schema.BooleanFromBit),
  ensuite: Schema.optional(Schema.BooleanFromBit),
  smoking: Schema.optional(Schema.BooleanFromBit),
  pets: Schema.optional(Schema.BooleanFromBit),
});
export type UpdateListingInput = typeof UpdateListingInput.Type;

/*
 * Search filters. Price bounds are inclusive, the bit flags filter on their
 * exact value (a `false` flag is a real filter, not an absent one), and
 * `availableFrom` means "available on or after" - rows with no availability
 * date are excluded when it is set, exactly like the legacy room search.
 */
export const ListingSearchFilters = Schema.Struct({
  kind: Schema.optional(ListingKind),
  regionCode: Schema.optional(GreekRegion),
  minPriceMinor: Schema.optional(Schema.Int),
  maxPriceMinor: Schema.optional(Schema.Int),
  furnished: Schema.optional(Schema.BooleanFromBit),
  ensuite: Schema.optional(Schema.BooleanFromBit),
  smoking: Schema.optional(Schema.BooleanFromBit),
  pets: Schema.optional(Schema.BooleanFromBit),
  availableFrom: Schema.optional(Schema.DateFromMillis),
});
export type ListingSearchFilters = typeof ListingSearchFilters.Type;

/*
 * Keyset cursor: the `(created_at, id)` of the last row a caller received. It is
 * opaque to clients at the HTTP boundary; the service and repository take the
 * struct so neither has to know the wire encoding.
 */
export const ListingCursor = Schema.Struct({
  createdAt: Schema.Number,
  id: ListingId,
});
export type ListingCursor = typeof ListingCursor.Type;

export const LISTING_PAGE_DEFAULT_LIMIT = 20;
export const LISTING_PAGE_MAX_LIMIT = 50;

export const ListingPageLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: LISTING_PAGE_MAX_LIMIT }),
);

// `limit` defaults to 20 on decode and is capped at 50, so no caller can ask for
// an unbounded page.
export const ListingPageRequest = Schema.Struct({
  limit: ListingPageLimit.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(LISTING_PAGE_DEFAULT_LIMIT)),
  ),
  cursor: Schema.optional(ListingCursor),
});
export type ListingPageRequest = typeof ListingPageRequest.Type;

export const ListingPage = Schema.Struct({
  items: Schema.Array(ListingSchema),
  nextCursor: Schema.NullishOr(ListingCursor),
});
export type ListingPage = typeof ListingPage.Type;
