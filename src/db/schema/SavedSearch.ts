import { SavedSearchId, UserId } from "@/db/schema/brands";
import { GreekRegion, ListingKind } from "@/db/schema/Listing";
import { Schema, SchemaTransformation } from "effect";

/*
 * A saved search is the listing feed's criteria kept under a name for one
 * account. The criteria are nullable because "any" is a real state: a null
 * column means the search did not narrow on that field, and a saved
 * `furnished = 0` is a filter rather than an absent one.
 *
 * The name is trimmed before it is bounded, exactly like a listing title, so a
 * padded name is stored trimmed and a whitespace-only one is rejected instead of
 * reaching the database CHECK.
 */
export const SavedSearchName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(120)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);

/*
 * The criteria one saved search stores: the shape the listing search filters on,
 * with the flags as booleans. The save route decodes and checks the criteria
 * through the search query codec, so this is the decoded shape, not a second
 * schema whose checks would never run.
 */
export interface SavedSearchCriteria {
  readonly kind?: typeof ListingKind.Type | undefined;
  readonly regionCode?: typeof GreekRegion.Type | undefined;
  readonly minPriceMinor?: number | undefined;
  readonly maxPriceMinor?: number | undefined;
  readonly minSizeSqm?: number | undefined;
  readonly maxSizeSqm?: number | undefined;
  readonly furnished?: boolean | undefined;
  readonly ensuite?: boolean | undefined;
  readonly smoking?: boolean | undefined;
  readonly pets?: boolean | undefined;
  readonly availableFrom?: Date | undefined;
}

/*
 * The values a caller saves: the criteria plus an optional name. The route
 * decodes both before this point, and the service fills in a name when it is
 * absent, so the browser form can leave its name box blank.
 */
export type SavedSearchInput = SavedSearchCriteria & {
  readonly name?: typeof SavedSearchName.Type | undefined;
};

// The values the repository insert takes: a name the service has already
// defaulted, plus the decoded criteria.
export type NewSavedSearch = SavedSearchCriteria & {
  readonly name: typeof SavedSearchName.Type;
};

/*
 * The wire shape of a saved search. The flags stay booleans here and the dates
 * travel as epoch millis, so a caller receives everything the results page needs
 * to re-run the search without a second read.
 */
export const SavedSearchSchema = Schema.Struct({
  id: SavedSearchId,
  userId: UserId,
  name: Schema.String,
  kind: Schema.NullishOr(ListingKind),
  regionCode: Schema.NullishOr(GreekRegion),
  minPriceMinor: Schema.NullishOr(Schema.Int),
  maxPriceMinor: Schema.NullishOr(Schema.Int),
  minSizeSqm: Schema.NullishOr(Schema.Int),
  maxSizeSqm: Schema.NullishOr(Schema.Int),
  furnished: Schema.NullishOr(Schema.Boolean),
  ensuite: Schema.NullishOr(Schema.Boolean),
  smoking: Schema.NullishOr(Schema.Boolean),
  pets: Schema.NullishOr(Schema.Boolean),
  availableFrom: Schema.NullishOr(Schema.DateFromMillis),
  createdAt: Schema.DateFromMillis,
});
export type SavedSearch = typeof SavedSearchSchema.Type;

/*
 * The row shape the repository decodes. It is the wire shape with the flags in
 * their stored `0 | 1` form, which `BooleanFromBit` turns back into booleans, so
 * everything above this line works with booleans only.
 */
export const SavedSearchRowSchema = Schema.Struct({
  ...SavedSearchSchema.fields,
  furnished: Schema.NullishOr(Schema.BooleanFromBit),
  ensuite: Schema.NullishOr(Schema.BooleanFromBit),
  smoking: Schema.NullishOr(Schema.BooleanFromBit),
  pets: Schema.NullishOr(Schema.BooleanFromBit),
});

// A path segment is not a saved-search id until it is a positive safe integer,
// so "new" or "1.5" reads as "no such saved search" instead of reaching SQL.
export const decodeSavedSearchId = (
  raw: string | undefined,
): typeof SavedSearchId.Type | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return Schema.decodeSync(SavedSearchId)(id);
};
