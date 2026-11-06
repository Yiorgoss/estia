import { ListingId, UserId } from "@/db/schema/brands";
import { BooleanFromString, NonBlankFiniteFromString } from "@/db/schema/codecs";
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";

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
 * Search filters. Price and size bounds are inclusive, the bit flags filter on
 * their exact value (a `false` flag is a real filter, not an absent one), and
 * `availableFrom` means "available on or after" - rows with no availability
 * date are excluded when it is set, exactly like the legacy room search.
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

/*
 * Keyset cursor: the `(created_at, id)` of the last row a caller received. It is
 * encoded at the HTTP boundary; the service and repository take the struct so
 * neither has to know the wire encoding.
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

/*
 * The cursor travels as `base64url("<createdAt>:<id>")`, so the sort key is not
 * a JSON field and there is no offset parameter to page with. It is
 * tamper-tolerant, not tamper-proof: a forged cursor is accepted, which is
 * harmless because it only moves the keyset window while the published-only
 * rule and every filter still apply.
 */
const CURSOR_PATTERN = /^(\d+):(\d+)$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const encodeListingCursor = (cursor: typeof ListingCursor.Encoded): string =>
  btoa(`${cursor.createdAt}:${cursor.id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeListingCursor = (value: string): typeof ListingCursor.Encoded | undefined => {
  // Only the base64url alphabet is accepted, so standard base64 (`+`, `/`, `=`)
  // is a malformed cursor instead of being silently normalised.
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;

  let decoded: string;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    decoded = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  } catch {
    return undefined;
  }

  const match = CURSOR_PATTERN.exec(decoded);
  if (match === null) return undefined;
  const createdAt = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(id)) return undefined;

  // The `ListingId` brand is applied by the target schema's own decoding; the
  // transformation only produces the cursor's encoded shape.
  return { createdAt, id };
};

// The string form of a cursor. Decoding a malformed cursor fails the request
// instead of dropping the filter and silently starting from the first page.
export const ListingCursorFromString: Schema.Codec<typeof ListingCursor.Type, string> =
  Schema.String.pipe(
    Schema.decodeTo(
      ListingCursor,
      SchemaTransformation.transformEffect({
        decode: (value, options) => {
          const cursor = decodeListingCursor(value);
          return cursor === undefined
            ? Effect.fail(
                new SchemaIssue.InvalidValue({ message: "Invalid cursor" }, value, options),
              )
            : Effect.succeed(cursor);
        },
        encode: (cursor) => Effect.succeed(encodeListingCursor(cursor)),
      }),
    ),
  );

/*
 * Query parameters arrive as strings, so every field of the search query needs
 * a string codec even though the decoded type stays the model's own. Bounds go
 * through the same non-blank finite codec as the room search, so a blank,
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

export const ListingSearchQuery = Schema.Struct({
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
  limit: ListingPageLimitFromString.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(LISTING_PAGE_DEFAULT_LIMIT)),
  ),
  cursor: Schema.optional(ListingCursorFromString),
}).check(
  Schema.makeFilter((query) => {
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
  }),
);
export type ListingSearchQuery = typeof ListingSearchQuery.Type;

// Query parameters arrive as a string tree, so the schema is read through this
// codec instead of its own encoded side.
export const ListingSearchQueryCodec = Schema.toCodecStringTree(ListingSearchQuery);
