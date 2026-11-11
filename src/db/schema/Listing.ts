import { ListingId, UserId } from "@/db/schema/brands";
import { BooleanFromString, NonBlankFiniteFromString } from "@/db/schema/codecs";
import { encodeKeysetCursor, KeysetCursor, KeysetCursorFromString } from "@/db/schema/cursor";
import { Effect, Schema, SchemaTransformation } from "effect";

/*
 * One listing table covers all three kinds of ad, so every schema here is
 * kind-agnostic. Kind-specific attributes are not modeled yet: the four room
 * bits stay `false` for a room-wanted ad.
 */

export const ListingKind = Schema.Literals(["room", "whole_property", "room_wanted"]);
export type ListingKind = typeof ListingKind.Type;

/*
 * A path segment is not an id until it is a positive safe integer, so "new" or
 * "1.5" reads as "no such listing" instead of reaching the database. Every page
 * that shows one listing decodes its path through this.
 */
export const decodeListingId = (raw: string | undefined): typeof ListingId.Type | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return Schema.decodeSync(ListingId)(id);
};

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
 *
 * The request schemas take any number and leave the box to `assertLocation` in
 * `src/services/listing.service.ts`, whose tagged error is the 422 a caller
 * sees; a bound in the schema would reject the same point as a generic 400
 * first. The database CHECK is the last line of defence.
 */
export const GREEK_LATITUDE_RANGE = { minimum: 34.0, maximum: 42.5 } as const;
export const GREEK_LONGITUDE_RANGE = { minimum: 19.0, maximum: 30.5 } as const;

// A title is trimmed before it is bounded, so a padded title is stored trimmed
// and a whitespace-only title is rejected instead of reaching the database.
export const ListingTitle = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(120)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);
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
  lat: Schema.optional(Schema.NullishOr(Schema.Number)),
  lng: Schema.optional(Schema.NullishOr(Schema.Number)),
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
  lat: Schema.optional(Schema.NullishOr(Schema.Number)),
  lng: Schema.optional(Schema.NullishOr(Schema.Number)),
  sizeSqm: Schema.optional(Schema.NullishOr(SizeSqm)),
  availableFrom: Schema.optional(Schema.NullishOr(Schema.DateFromMillis)),
  furnished: Schema.optional(Schema.BooleanFromBit),
  ensuite: Schema.optional(Schema.BooleanFromBit),
  smoking: Schema.optional(Schema.BooleanFromBit),
  pets: Schema.optional(Schema.BooleanFromBit),
});
export type UpdateListingInput = typeof UpdateListingInput.Type;

/*
 * Search filters. Price and size bounds are inclusive, the bit flags filter on
 * their exact value (a `false` flag is a real filter, not an absent one), and
 * `availableFrom` means "available on or after" - rows with no availability
 * date are excluded when it is set.
 */
export const ListingSearchFilters = Schema.Struct({
  kind: Schema.optional(ListingKind),
  regionCode: Schema.optional(GreekRegion),
  minPriceMinor: Schema.optional(Schema.Int),
  maxPriceMinor: Schema.optional(Schema.Int),
  minSizeSqm: Schema.optional(Schema.Int),
  maxSizeSqm: Schema.optional(Schema.Int),
  furnished: Schema.optional(Schema.BooleanFromBit),
  ensuite: Schema.optional(Schema.BooleanFromBit),
  smoking: Schema.optional(Schema.BooleanFromBit),
  pets: Schema.optional(Schema.BooleanFromBit),
  availableFrom: Schema.optional(Schema.DateFromMillis),
});
export type ListingSearchFilters = typeof ListingSearchFilters.Type;

export const ListingCursor = KeysetCursor;
export type ListingCursor = typeof ListingCursor.Type;

export const encodeListingCursor = encodeKeysetCursor;
export const ListingCursorFromString = KeysetCursorFromString;

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

/*
 * Query parameters arrive as strings, so every field of the search query needs
 * a string codec even though the decoded type stays the model's own. Bounds go
 * through the non-blank finite codec, so a blank,
 * non-numeric, non-finite, negative, or fractional value is a bad request
 * rather than a filter that silently matches nothing. `limit` decodes through
 * `ListingPageLimit`, so the default and the cap keep their one definition in
 * the page request above.
 */
const NonNegativeIntFromString = NonBlankFiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const ListingPageLimitFromString = NonBlankFiniteFromString.pipe(
  Schema.decodeTo(ListingPageLimit, SchemaTransformation.passthrough()),
);

/*
 * The paging contract both listing feeds share. Declaring the fields once keeps
 * the two feeds from drifting: `limit` defaults to 20 and is capped at 50, and
 * the cursor is the opaque base64url token, never an offset.
 */
const pagingQueryFields = {
  limit: ListingPageLimitFromString.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(LISTING_PAGE_DEFAULT_LIMIT)),
  ),
  cursor: Schema.optional(ListingCursorFromString),
};

/*
 * The filter vocabulary every listing surface speaks: the search feed, the map,
 * and (in phase 2) the search page's map toggle. Declaring the fields once is
 * what keeps those surfaces from drifting apart.
 */
const searchFilterQueryFields = {
  kind: Schema.optional(ListingKind),
  regionCode: Schema.optional(GreekRegion),
  minPriceMinor: Schema.optional(NonNegativeIntFromString),
  maxPriceMinor: Schema.optional(NonNegativeIntFromString),
  minSizeSqm: Schema.optional(NonNegativeIntFromString),
  maxSizeSqm: Schema.optional(NonNegativeIntFromString),
  furnished: Schema.optional(BooleanFromString),
  ensuite: Schema.optional(BooleanFromString),
  smoking: Schema.optional(BooleanFromString),
  pets: Schema.optional(BooleanFromString),
  availableFrom: Schema.optional(Schema.DateFromString),
};

// An inverted range is a client mistake, not an empty result: it fails the
// whole request instead of silently matching nothing.
const validateFilterRanges = (query: {
  readonly minPriceMinor?: number | undefined;
  readonly maxPriceMinor?: number | undefined;
  readonly minSizeSqm?: number | undefined;
  readonly maxSizeSqm?: number | undefined;
}): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = [];
  if (
    query.minPriceMinor !== undefined &&
    query.maxPriceMinor !== undefined &&
    query.minPriceMinor > query.maxPriceMinor
  ) {
    issues.push({
      path: ["minPriceMinor"],
      issue: "minPriceMinor must not be greater than maxPriceMinor",
    });
  }
  if (
    query.minSizeSqm !== undefined &&
    query.maxSizeSqm !== undefined &&
    query.minSizeSqm > query.maxSizeSqm
  ) {
    issues.push({
      path: ["minSizeSqm"],
      issue: "minSizeSqm must not be greater than maxSizeSqm",
    });
  }
  return issues;
};

export const ListingSearchQuery = Schema.Struct({
  ...searchFilterQueryFields,
  ...pagingQueryFields,
}).check(Schema.makeFilter(validateFilterRanges));
export type ListingSearchQuery = typeof ListingSearchQuery.Type;

// Query parameters arrive as a string tree, so the schema is read through this
// codec instead of its own encoded side.
export const ListingSearchQueryCodec = Schema.toCodecStringTree(ListingSearchQuery);

// The owner's own feed filters on nothing at all: every status, newest first.
// Only the paging contract above travels as query data.
export const ListingMineQuery = Schema.Struct({ ...pagingQueryFields });
export type ListingMineQuery = typeof ListingMineQuery.Type;

export const ListingMineQueryCodec = Schema.toCodecStringTree(ListingMineQuery);

/*
 * The map contract. It takes the feed's whole filter vocabulary but bounds the
 * response instead of paging it: the map shows the newest pins up to the cap,
 * and `truncated` says whether older listings were left off. A limit above the
 * cap is a bad request rather than a silent clamp, so a caller never believes
 * it received every pin when it did not.
 */
export const LISTING_MAP_DEFAULT_LIMIT = 500;
export const LISTING_MAP_MAX_LIMIT = 500;

export const ListingMapLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: LISTING_MAP_MAX_LIMIT }),
);

const ListingMapLimitFromString = NonBlankFiniteFromString.pipe(
  Schema.decodeTo(ListingMapLimit, SchemaTransformation.passthrough()),
);

export const ListingMapQuery = Schema.Struct({
  ...searchFilterQueryFields,
  limit: ListingMapLimitFromString.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(LISTING_MAP_DEFAULT_LIMIT)),
  ),
}).check(Schema.makeFilter(validateFilterRanges));
export type ListingMapQuery = typeof ListingMapQuery.Type;
