import { SavedSearchId, UserId } from "@/db/schema/brands";
import type { SavedSearch, SavedSearchCriteria, SavedSearchInput } from "@/db/schema/SavedSearch";
import { SavedSearchRepository } from "@/repos/saved-search.repo";
import { InternalError } from "@/services/user.service";
import { kindLabels, regionLabels } from "@/frontend/listing-labels";
import { formatDate, formatPriceMinor } from "@/utils";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The saved-search service. It owns the one rule that needs more than a row: a
 * search saved without a name is named after its criteria, so the list the
 * person comes back to always reads as something. Everything else is the
 * account scope the repository enforces in SQL.
 */

export class SavedSearchNotFoundError extends Schema.TaggedError<SavedSearchNotFoundError>()(
  "SavedSearchNotFoundError",
  { id: SavedSearchId },
  { httpApiStatus: 404 },
) {}

const rangeSummary = (
  min: number | undefined,
  max: number | undefined,
  format: (value: number) => string,
  suffix: string,
): string | undefined => {
  if (min !== undefined && max !== undefined) return `${format(min)}-${format(max)}${suffix}`;
  if (max !== undefined) return `up to ${format(max)}${suffix}`;
  if (min !== undefined) return `from ${format(min)}${suffix}`;
  return undefined;
};

/*
 * A readable name for a search saved without one. It reads in the same order
 * the form does - kind, region, price, size, flags, availability - and never
 * exceeds the name bound, so it can be stored as a name as-is.
 */
export const summarizeSavedSearch = (criteria: SavedSearchCriteria): string => {
  // A search that narrows on nothing reads as the whole feed, not as a list of
  // missing filters.
  if (
    criteria.kind === undefined &&
    criteria.regionCode === undefined &&
    criteria.minPriceMinor === undefined &&
    criteria.maxPriceMinor === undefined &&
    criteria.minSizeSqm === undefined &&
    criteria.maxSizeSqm === undefined &&
    criteria.furnished === undefined &&
    criteria.ensuite === undefined &&
    criteria.smoking === undefined &&
    criteria.pets === undefined &&
    criteria.availableFrom == null
  ) {
    return "All listings";
  }

  const head: Array<string> = [];
  head.push(criteria.kind === undefined ? "Listings" : kindLabels[criteria.kind]);
  if (criteria.regionCode !== undefined) head.push(`in ${regionLabels[criteria.regionCode]}`);

  const price = rangeSummary(
    criteria.minPriceMinor,
    criteria.maxPriceMinor,
    formatPriceMinor,
    "/mo",
  );
  if (price !== undefined) head.push(price);
  const size = rangeSummary(criteria.minSizeSqm, criteria.maxSizeSqm, String, " m²");
  if (size !== undefined) head.push(size);

  const flags: Array<string> = [];
  const flagPhrases = [
    [criteria.furnished, "Furnished", "Not furnished"],
    [criteria.ensuite, "Ensuite", "No ensuite"],
    [criteria.smoking, "Smoking allowed", "No smoking"],
    [criteria.pets, "Pets allowed", "No pets"],
  ] as const;
  for (const [value, whenTrue, whenFalse] of flagPhrases) {
    if (value === true) flags.push(whenTrue);
    else if (value === false) flags.push(whenFalse);
  }
  if (flags.length > 0) head.push(flags.join(", "));

  const available = criteria.availableFrom;
  if (available !== undefined && available !== null) {
    head.push(`available from ${formatDate(available) ?? ""}`);
  }

  const summary = head.join(" ").trim();
  return summary.length <= 120 ? summary : `${summary.slice(0, 117).trimEnd()}...`;
};

export interface SavedSearchService {
  readonly create: (
    ownerId: typeof UserId.Type,
    input: SavedSearchInput,
  ) => Effect.Effect<SavedSearch, InternalError>;

  readonly list: (
    ownerId: typeof UserId.Type,
  ) => Effect.Effect<ReadonlyArray<SavedSearch>, InternalError>;

  readonly findOwned: (
    ownerId: typeof UserId.Type,
    id: typeof SavedSearchId.Type,
  ) => Effect.Effect<Option.Option<SavedSearch>, InternalError>;

  readonly delete: (
    ownerId: typeof UserId.Type,
    id: typeof SavedSearchId.Type,
  ) => Effect.Effect<void, SavedSearchNotFoundError | InternalError>;
}

export const SavedSearchService = Context.Service<SavedSearchService>("SavedSearchService");

// Services collapse driver failures into `InternalError` and log the real cause.
const fromSql = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, InternalError> =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.logError("Saved search operation failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        ),
    }),
  );

export const SavedSearchServiceLive = Layer.effect(
  SavedSearchService,
  Effect.gen(function* () {
    const repo = yield* SavedSearchRepository;

    return {
      create: (ownerId, input) =>
        Effect.gen(function* () {
          const { name, ...criteria } = input;
          const values = { ...criteria, name: name ?? summarizeSavedSearch(criteria) };
          return yield* fromSql(repo.create(ownerId, values));
        }),
      list: (ownerId) => fromSql(repo.listByUser(ownerId)),
      findOwned: (ownerId, id) => fromSql(repo.findByIdForUser(ownerId, id)),
      delete: (ownerId, id) =>
        fromSql(repo.deleteForUser(ownerId, id)).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new SavedSearchNotFoundError({ id })),
              onSome: () => Effect.void,
            }),
          ),
        ),
    } satisfies SavedSearchService;
  }),
);
