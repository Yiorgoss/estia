import { ListingId, UserId } from "@/db/schema/brands";
import type { KeysetCursor } from "@/db/schema/cursor";
import { EnquiryMessage } from "@/db/schema/Enquiry";
import type { Enquiry, ReceivedEnquiryPage, SentEnquiryPage } from "@/db/schema/Enquiry";
import { ListingRepository } from "@/repos/listing.repo";
import { ListerRepository } from "@/repos/lister.repo";
import { EnquiryRepository } from "@/repos/enquiry.repo";
import { SeekerRepository } from "@/repos/seeker.repo";
import { UserRepository } from "@/repos/user.repo";
import { InternalError } from "@/services/user.service";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The contact path. Sending an enquiry needs three rules that span rows: the
 * listing has to be one a public visitor can see, the sender cannot be its
 * owner, and a sender cannot flood a lister. Everything else is a scoped read:
 * the sent list is the caller's, the received list is every enquiry on a listing
 * the caller owns.
 *
 * Reading a lister's published contact line also lives here, because it is the
 * other half of the same loop and has the same audience rule - signed-in people
 * only, never a public payload.
 */

export class EnquiryListingNotFoundError extends Schema.TaggedError<EnquiryListingNotFoundError>()(
  "EnquiryListingNotFoundError",
  { id: ListingId },
  { httpApiStatus: 404 },
) {}

export class EnquiryOwnListingError extends Schema.TaggedError<EnquiryOwnListingError>()(
  "EnquiryOwnListingError",
  { id: ListingId },
  { httpApiStatus: 409 },
) {}

export class EnquiryValidationError extends Schema.TaggedError<EnquiryValidationError>()(
  "EnquiryValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// A refusal with a time attached: the sender can try again once the window has
// moved on. It is deliberately one small counter, not a spam score.
export class EnquiryRateLimitedError extends Schema.TaggedError<EnquiryRateLimitedError>()(
  "EnquiryRateLimitedError",
  { limit: Schema.Number, windowSeconds: Schema.Number },
  { httpApiStatus: 429 },
) {}

export const ENQUIRY_RATE_LIMIT = 20;
export const ENQUIRY_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface ListerContact {
  readonly name: string | null;
  readonly contact: string | null;
}

export interface EnquiryService {
  readonly send: (
    senderId: typeof UserId.Type,
    listingId: typeof ListingId.Type,
    input: { readonly message: string },
  ) => Effect.Effect<
    Enquiry,
    | EnquiryListingNotFoundError
    | EnquiryOwnListingError
    | EnquiryValidationError
    | EnquiryRateLimitedError
    | InternalError
  >;

  readonly listSent: (
    senderId: typeof UserId.Type,
    cursor?: KeysetCursor,
  ) => Effect.Effect<typeof SentEnquiryPage.Type, InternalError>;

  readonly listReceived: (
    ownerId: typeof UserId.Type,
    cursor?: KeysetCursor,
  ) => Effect.Effect<typeof ReceivedEnquiryPage.Type, InternalError>;

  /*
   * The contact line a lister chose to publish. It is not part of any public
   * listing payload; a signed-in detail page reads it through here.
   */
  readonly listerContactOf: (
    ownerId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<ListerContact>, InternalError>;
}

export const EnquiryService = Context.Service<EnquiryService>("EnquiryService");

const fromSql = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, InternalError> =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.logError("Enquiry operation failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        ),
    }),
  );

const nonBlank = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

const decodeMessage = (raw: string): Effect.Effect<string, EnquiryValidationError> =>
  Schema.decodeUnknownEffect(EnquiryMessage)(raw).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new EnquiryValidationError({
          message: "Write a message up to 2000 characters.",
        }),
      ),
    ),
  );

export const EnquiryServiceLive = Layer.effect(
  EnquiryService,
  Effect.gen(function* () {
    const listings = yield* ListingRepository;
    const enquiries = yield* EnquiryRepository;
    const listers = yield* ListerRepository;
    const seekers = yield* SeekerRepository;
    const users = yield* UserRepository;

    return {
      send: (senderId, listingId, input) =>
        Effect.gen(function* () {
          const message = yield* decodeMessage(input.message);

          const found = yield* fromSql(listings.findById(listingId));
          const listing = yield* Option.match(found, {
            // A draft or unlisted listing answers the same 404 as an unknown id,
            // exactly like the public detail read, so an id cannot be probed.
            onNone: () => Effect.fail(new EnquiryListingNotFoundError({ id: listingId })),
            onSome: (row) =>
              row.status === "published"
                ? Effect.succeed(row)
                : Effect.fail(new EnquiryListingNotFoundError({ id: listingId })),
          });

          if (listing.ownerId === senderId) {
            return yield* Effect.fail(new EnquiryOwnListingError({ id: listingId }));
          }

          const now = yield* Clock.currentTimeMillis;
          const recent = yield* fromSql(
            enquiries.countRecentBySender(senderId, now - ENQUIRY_RATE_WINDOW_MS),
          );
          if (recent >= ENQUIRY_RATE_LIMIT) {
            return yield* Effect.fail(
              new EnquiryRateLimitedError({
                limit: ENQUIRY_RATE_LIMIT,
                windowSeconds: ENQUIRY_RATE_WINDOW_MS / 1000,
              }),
            );
          }

          const seeker = Option.getOrNull(yield* fromSql(seekers.findByUserId(senderId)));
          const lister = Option.getOrNull(yield* fromSql(listers.findByUserId(senderId)));
          const account = Option.getOrNull(yield* fromSql(users.findById(senderId)));
          const accountEmail = nonBlank(account?.email);
          const senderName = nonBlank(seeker?.name) ?? nonBlank(lister?.name) ?? accountEmail;
          if (senderName === undefined) {
            return yield* Effect.fail(
              new EnquiryValidationError({
                message:
                  "Your account has no name or email to show the lister. Add a name to your profile before sending an enquiry.",
              }),
            );
          }
          const senderContact =
            nonBlank(seeker?.contact) ?? nonBlank(lister?.contact) ?? accountEmail;
          if (senderContact === undefined) {
            return yield* Effect.fail(
              new EnquiryValidationError({
                message:
                  "Your account has no contact detail to show the lister. Add a contact detail to your profile before sending an enquiry.",
              }),
            );
          }

          return yield* fromSql(
            enquiries.create(listingId, senderId, message, senderName, senderContact),
          );
        }),
      listSent: (senderId, cursor) => fromSql(enquiries.listBySender(senderId, cursor)),
      listReceived: (ownerId, cursor) => fromSql(enquiries.listByOwner(ownerId, cursor)),
      listerContactOf: (ownerId) =>
        fromSql(listers.findByUserId(ownerId)).pipe(
          Effect.map(
            Option.map((profile) => ({
              name: profile.name ?? null,
              contact: profile.contact ?? null,
            })),
          ),
        ),
    } satisfies EnquiryService;
  }),
);
