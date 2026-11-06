import { ListingId, UserId } from "@/db/schema/brands";
import {
  CreateListingInput,
  GREEK_LATITUDE_RANGE,
  GREEK_LONGITUDE_RANGE,
  ListingPage,
  ListingPageRequest,
  ListingSchema,
  ListingSearchFilters,
  ListingStatus,
  ListingTitle,
  UpdateListingInput,
} from "@/db/schema/Listing";
import { ListingRepository } from "@/repos/listing.repo";
import { InternalError } from "@/services/user.service";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The listings service owns every rule that needs the current row or a
 * cross-field view: ownership, the status state machine, and the coordinate
 * pair. It also decodes the title with the shared codec, so a caller that
 * reaches it without the HTTP boundary still gets the trimmed value and a 400
 * instead of a database error; the database CHECK/foreign-key constraints
 * remain the last line of defence.
 */

export class ListingNotFoundError extends Schema.TaggedError<ListingNotFoundError>()(
  "ListingNotFoundError",
  { id: ListingId },
  { httpApiStatus: 404 },
) {}

export class ListingNotOwnedError extends Schema.TaggedError<ListingNotOwnedError>()(
  "ListingNotOwnedError",
  { id: ListingId },
  { httpApiStatus: 403 },
) {}

export class InvalidListingTransitionError extends Schema.TaggedError<InvalidListingTransitionError>()(
  "InvalidListingTransitionError",
  { id: ListingId, from: ListingStatus, to: ListingStatus },
  { httpApiStatus: 409 },
) {}

export class ListingLocationOutOfGreeceError extends Schema.TaggedError<ListingLocationOutOfGreeceError>()(
  "ListingLocationOutOfGreeceError",
  { lat: Schema.Number, lng: Schema.Number },
  { httpApiStatus: 422 },
) {}

export class ListingValidationError extends Schema.TaggedError<ListingValidationError>()(
  "ListingValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/*
 * The whole status machine. Unlisting is a reversible status change, never a
 * delete, and there is no admin surface in the MVP: only the owner transitions.
 */
const allowedTransitions: Record<
  typeof ListingStatus.Type,
  ReadonlyArray<typeof ListingStatus.Type>
> = {
  draft: ["published"],
  published: ["unpublished"],
  unpublished: ["published"],
};

/*
 * The coarse Greek bounding box. It is a sanity check, not a boundary: it
 * rejects a point in Valencia and accepts one in Istanbul, so the required
 * region stays the real gate. `packages/map/greece.json` is deliberately not
 * wired in here - its single 11-point ring both accepts foreign land (Izmir,
 * Sarande) and rejects a real Greek island (Kastellorizo), so it cannot be
 * presented as "Greece only".
 */
const inGreekBoundingBox = (lat: number, lng: number): boolean =>
  lat >= GREEK_LATITUDE_RANGE.minimum &&
  lat <= GREEK_LATITUDE_RANGE.maximum &&
  lng >= GREEK_LONGITUDE_RANGE.minimum &&
  lng <= GREEK_LONGITUDE_RANGE.maximum;

// Both-or-neither, and both inside the coarse box when present.
const assertLocation = (
  lat: number | null | undefined,
  lng: number | null | undefined,
): Effect.Effect<void, ListingValidationError | ListingLocationOutOfGreeceError> =>
  Effect.gen(function* () {
    if (lat == null && lng == null) return;
    if (lat == null || lng == null) {
      return yield* Effect.fail(
        new ListingValidationError({ message: "lat and lng must be provided together" }),
      );
    }
    if (!inGreekBoundingBox(lat, lng)) {
      return yield* Effect.fail(new ListingLocationOutOfGreeceError({ lat, lng }));
    }
  });

export interface ListingService {
  readonly createDraft: (
    ownerId: typeof UserId.Type,
    input: typeof CreateListingInput.Type,
  ) => Effect.Effect<
    typeof ListingSchema.Type,
    ListingValidationError | ListingLocationOutOfGreeceError | InternalError
  >;

  readonly updateListing: (
    ownerId: typeof UserId.Type,
    id: typeof ListingId.Type,
    input: typeof UpdateListingInput.Type,
  ) => Effect.Effect<
    typeof ListingSchema.Type,
    | ListingNotFoundError
    | ListingNotOwnedError
    | ListingValidationError
    | ListingLocationOutOfGreeceError
    | InternalError
  >;

  readonly publish: (
    ownerId: typeof UserId.Type,
    id: typeof ListingId.Type,
  ) => Effect.Effect<
    typeof ListingSchema.Type,
    ListingNotFoundError | ListingNotOwnedError | InvalidListingTransitionError | InternalError
  >;

  readonly unlist: (
    ownerId: typeof UserId.Type,
    id: typeof ListingId.Type,
  ) => Effect.Effect<
    typeof ListingSchema.Type,
    ListingNotFoundError | ListingNotOwnedError | InvalidListingTransitionError | InternalError
  >;

  readonly getOwn: (
    ownerId: typeof UserId.Type,
    id: typeof ListingId.Type,
  ) => Effect.Effect<
    typeof ListingSchema.Type,
    ListingNotFoundError | ListingNotOwnedError | InternalError
  >;

  readonly getPublic: (
    id: typeof ListingId.Type,
  ) => Effect.Effect<typeof ListingSchema.Type, ListingNotFoundError | InternalError>;

  readonly listMine: (
    ownerId: typeof UserId.Type,
    page: typeof ListingPageRequest.Type,
  ) => Effect.Effect<typeof ListingPage.Type, InternalError>;

  readonly search: (
    filters: typeof ListingSearchFilters.Type,
    page: typeof ListingPageRequest.Type,
  ) => Effect.Effect<typeof ListingPage.Type, InternalError>;
}

export const ListingService = Context.Service<ListingService>("ListingService");

// A title that does not satisfy the shared codec is a bad request (400), never a
// driver failure: a whitespace-only title must not reach the database CHECK.
const decodeTitle = (title: string): Effect.Effect<string, ListingValidationError> =>
  Schema.decodeUnknownEffect(ListingTitle)(title).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new ListingValidationError({ message: String(error) })),
    ),
  );

// Services collapse driver failures into `InternalError` (the 500 contract every
// other service already follows) and log the real cause.
const fromSql = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, InternalError> =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.logError("Listing operation failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        ),
    }),
  );

export const ListingServiceLive = Layer.effect(
  ListingService,
  Effect.gen(function* () {
    const repo = yield* ListingRepository;

    // Loads a listing for its owner: missing is 404, someone else's is 403.
    const loadOwned = (ownerId: typeof UserId.Type, id: typeof ListingId.Type) =>
      Effect.gen(function* () {
        const found = yield* fromSql(repo.findById(id));
        const listing = yield* Option.match(found, {
          onNone: () => Effect.fail(new ListingNotFoundError({ id })),
          onSome: Effect.succeed,
        });
        if (listing.ownerId !== ownerId) {
          return yield* Effect.fail(new ListingNotOwnedError({ id }));
        }
        return listing;
      });

    const transition = (
      ownerId: typeof UserId.Type,
      id: typeof ListingId.Type,
      to: typeof ListingStatus.Type,
    ) =>
      Effect.gen(function* () {
        const current = yield* loadOwned(ownerId, id);
        if (!allowedTransitions[current.status].includes(to)) {
          return yield* Effect.fail(
            new InvalidListingTransitionError({ id, from: current.status, to }),
          );
        }
        // Compare-and-set: `from` is the status the service just read, so a
        // concurrent transition cannot be overwritten and the loser gets a 409.
        const updated = yield* fromSql(repo.setStatus(id, ownerId, [current.status], to));
        if (Option.isNone(updated)) {
          return yield* Effect.fail(
            new InvalidListingTransitionError({ id, from: current.status, to }),
          );
        }
        return updated.value;
      });

    return {
      createDraft: (ownerId, input) =>
        Effect.gen(function* () {
          const values = { ...input, title: yield* decodeTitle(input.title) };
          yield* assertLocation(values.lat, values.lng);
          return yield* fromSql(repo.create(ownerId, values));
        }),
      updateListing: (ownerId, id, input) =>
        Effect.gen(function* () {
          const title = input.title === undefined ? undefined : yield* decodeTitle(input.title);
          const values = { ...input, title };
          const current = yield* loadOwned(ownerId, id);
          // Merge before validating so a partial update cannot leave a
          // half-populated coordinate pair behind.
          yield* assertLocation(
            values.lat === undefined ? current.lat : values.lat,
            values.lng === undefined ? current.lng : values.lng,
          );
          const updated = yield* fromSql(repo.update(id, ownerId, values));
          if (Option.isNone(updated)) {
            return yield* Effect.fail(new ListingNotFoundError({ id }));
          }
          return updated.value;
        }),
      publish: (ownerId, id) => transition(ownerId, id, "published"),
      unlist: (ownerId, id) => transition(ownerId, id, "unpublished"),
      getOwn: (ownerId, id) => loadOwned(ownerId, id),
      getPublic: (id) =>
        Effect.gen(function* () {
          const found = yield* fromSql(repo.findById(id));
          const listing = yield* Option.match(found, {
            onNone: () => Effect.fail(new ListingNotFoundError({ id })),
            onSome: Effect.succeed,
          });
          // A public caller cannot probe the existence of a draft or an
          // unlisted listing: unpublished means 404, not 403.
          if (listing.status !== "published") {
            return yield* Effect.fail(new ListingNotFoundError({ id }));
          }
          return listing;
        }),
      listMine: (ownerId, page) => fromSql(repo.listByOwner(ownerId, page)),
      search: (filters, page) => fromSql(repo.search(filters, page)),
    } satisfies ListingService;
  }),
);
