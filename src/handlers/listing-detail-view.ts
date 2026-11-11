import type { PublicListing } from "@/api/public";
import type { UserId } from "@/db/schema/brands";
import { listingDetailPage } from "@/frontend/pages/listing-detail";
import { EnquiryService } from "@/services/enquiry.service";
import { InternalError } from "@/services/user.service";
import { Effect, Option } from "effect";

/*
 * One place builds the public detail page, so the anonymous read and the
 * enquiry form's rejected submit cannot disagree about who is reading or what
 * they are allowed to see. The listing arrives already projected, photos
 * included; the lister's published contact line is fetched only for a signed-in
 * reader who is not the owner, which is also the only case in which it renders.
 */
export const renderListingDetail = (
  listing: PublicListing,
  ownerId: typeof UserId.Type,
  viewerId: Option.Option<typeof UserId.Type>,
  state: { readonly message?: string | undefined; readonly error?: string | undefined } = {},
): Effect.Effect<string, InternalError, EnquiryService> =>
  Effect.gen(function* () {
    const signedIn = Option.isSome(viewerId);
    const isOwner = signedIn && ownerId === viewerId.value;

    const contact =
      signedIn && !isOwner
        ? yield* Effect.gen(function* () {
            const service = yield* EnquiryService;
            return yield* service.listerContactOf(ownerId);
          })
        : Option.none();

    return listingDetailPage(listing, {
      signedIn,
      isOwner,
      listerName: Option.getOrNull(Option.map(contact, (details) => details.name)),
      listerContact: Option.getOrNull(Option.map(contact, (details) => details.contact)),
      enquiryMessage: state.message,
      enquiryError: state.error,
    });
  });
