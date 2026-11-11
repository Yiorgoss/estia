import { SavedSearchId, UserId } from "@/db/schema/brands";
import {
  GreekRegion,
  ListingKind,
  ListingSearchText,
  validateFilterRanges,
} from "@/db/schema/Listing";
import { Schema, SchemaTransformation } from "effect";

/*
 * A saved search is the listing feed's criteria, plus the free-text query, kept
 * under a name for one account. The criteria are nullable because "any" is a
 * real state: a null column means the search did not narrow on that field, and a
 * saved `furnished = 0` is a filter rather than an absent one.
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

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/*
 * The criteria one saved search stores. It mirrors `ListingSearchFilters`, but
 * as a request payload: the flags are booleans on the wire and the repository
 * turns them into the bits the table keeps. The ranges are checked by the same
 * rule the search query uses, so a stored range can always be re-run.
 */
export const SavedSearchCriteria = Schema.Struct({
  query: Schema.optional(ListingSearchText),
  kind: Schema.optional(ListingKind),
  regionCode: Schema.optional(GreekRegion),
  minPriceMinor: Schema.optional(NonNegativeInt),
  maxPriceMinor: Schema.optional(NonNegativeInt),
  minSizeSqm: Schema.optional(NonNegativeInt),
  maxSizeSqm: Schema.optional(NonNegativeInt),
  furnished: Schema.optional(Schema.Boolean),
  ensuite: Schema.optional(Schema.Boolean),
  smoking: Schema.optional(Schema.Boolean),
  pets: Schema.optional(Schema.Boolean),
  availableFrom: Schema.optional(Schema.DateFromMillis),
});
export type SavedSearchCriteria = typeof SavedSearchCriteria.Type;

/*
 * Creating a saved search takes the criteria and an optional name. An omitted
 * name is filled in by the service with a readable summary of the criteria, so
 * the browser form can leave its name box blank.
 */
export const CreateSavedSearchInput = Schema.Struct({
  name: Schema.optional(SavedSearchName),
  ...SavedSearchCriteria.fields,
}).check(Schema.makeFilter(validateFilterRanges));
export type CreateSavedSearchInput = typeof CreateSavedSearchInput.Type;

// The values the repository insert takes: a name the service has already
// defaulted, plus the decoded criteria.
export const NewSavedSearch = Schema.Struct({
  name: SavedSearchName,
  ...SavedSearchCriteria.fields,
});
export type NewSavedSearch = typeof NewSavedSearch.Type;

/*
 * The wire shape of a saved search. The flags stay booleans here and the dates
 * travel as epoch millis, so a caller receives everything the results page needs
 * to re-run the search without a second read.
 */
export const SavedSearchSchema = Schema.Struct({
  id: SavedSearchId,
  userId: UserId,
  name: Schema.String,
  query: Schema.NullishOr(Schema.String),
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
