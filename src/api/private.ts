import { ListerSchema } from "@/db/schema/Lister";
import { SeekerSchema } from "@/db/schema/Seeker";
import { ProfileInput, RoleSwitchQuery } from "@/db/schema/Profile";
import { ListingId, UserRoles } from "@/db/schema/brands";
import { CurrentUser } from "@/db/schema/User";
import {
  CreateListingInput,
  ListingCursorFromString,
  ListingMineQuery,
  ListingSchema,
  UpdateListingInput,
} from "@/db/schema/Listing";
import { UnauthorizedError } from "@/services/auth.service";
import {
  AdminRoleSwitchError,
  InternalError,
  ProfileUnavailableError,
  ProfileValidationError,
  UnassignedRoleSwitchError,
} from "@/services/user.service";
import {
  InvalidListingTransitionError,
  ListingLocationOutOfGreeceError,
  ListingNotFoundError,
  ListingNotOwnedError,
  ListingValidationError,
} from "@/services/listing.service";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Schema } from "effect";
import { ListingPageRoutes } from "@/handlers/private/listing-pages";
import { ListingPhotoPageRoutes } from "@/handlers/private/listing-photo-pages";
import { ProfilePageRoutes } from "@/handlers/private/profile-pages";
import { SavedSearchRoutes } from "@/handlers/private/saved-search-routes";
import { EnquiryPageRoutes } from "@/handlers/private/enquiry-pages";
import {
  EnquiryPageQuery,
  EnquirySchema,
  ReceivedEnquiryPage,
  SendEnquiryInput,
  SentEnquiryPage,
} from "@/db/schema/Enquiry";
import {
  EnquiryListingNotFoundError,
  EnquiryOwnListingError,
  EnquiryRateLimitedError,
  EnquiryValidationError,
} from "@/services/enquiry.service";

/*
 * The caller's own profile. The role is the account's stored role, which is what
 * decides which of the two shapes the profile has; the profile is null until a
 * legacy account's missing row is opened by its first save. An unassigned
 * account reads as a null profile with the role it still has; saving or picking
 * a profile assigns the role.
 */
export const ProfileResponse = Schema.Struct({
  role: UserRoles,
  profile: Schema.NullOr(Schema.Union([SeekerSchema, ListerSchema])),
});

export const UserGroup = HttpApiGroup.make("user-group")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: Schema.Struct({
        user: CurrentUser,
        // An account whose role has no profile row yet is a normal state, not a
        // failure: an account created before registration provisioned profiles
        // is exactly that.
        userProfile: Schema.NullOr(Schema.Union([SeekerSchema, ListerSchema])),
      }),
      error: [InternalError, UnauthorizedError],
    }),
  )
  .add(
    HttpApiEndpoint.get("profile", "/profile", {
      success: ProfileResponse,
      // An admin holds no profile to read, and says so instead of inventing
      // one. An unassigned account reads as a null profile until it picks one.
      error: [ProfileUnavailableError, InternalError, UnauthorizedError],
    }),
  )
  .add(
    HttpApiEndpoint.put("save-profile", "/profile", {
      // The payload is validated at the boundary: a seeking profile needs a
      // name, a date of birth and a gender, and a listing profile needs an
      // ownership. The server applies it to the account's own role, or lets an
      // unassigned account adopt the role the payload describes.
      payload: ProfileInput,
      success: ProfileResponse,
      error: [ProfileUnavailableError, ProfileValidationError, InternalError, UnauthorizedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("change-role", "/change-role", {
      // A switch from an unassigned account names the profile it adopts. An
      // assigned account flips without one, or moves to the role it names.
      query: RoleSwitchQuery,
      success: Schema.Struct({
        newProfile: Schema.Union([SeekerSchema, ListerSchema]),
      }),
      // An admin has no profile to switch between, and an unassigned account
      // that names no role gives the switch nothing to adopt.
      error: [AdminRoleSwitchError, UnassignedRoleSwitchError, InternalError, UnauthorizedError],
    }),
  )
  // A group prefix only applies to the endpoints added before it.
  .prefix("/users");

/*
 * The owner's own feed. Unlike the public search feed there is no projection:
 * the caller is the owner of every row, so the whole listing - id, status,
 * timestamps, and its own owner id - is theirs to read. The cursor is encoded
 * for the wire exactly as the model defines it, so the page can hand it back
 * untouched.
 */
export const MyListingPageResponse = Schema.Struct({
  items: Schema.Array(ListingSchema),
  nextCursor: Schema.NullishOr(ListingCursorFromString),
});
export type MyListingPageResponse = typeof MyListingPageResponse.Type;

/*
 * Owner-scoped listing endpoints. The caller is always the owner, so no request
 * carries an owner id: the cookie is the identity, `mine` only ever reads rows
 * that bearer owns, and `ownerId`, `status`, and the timestamps are never
 * request data for a write (a new listing is always a draft, and only the
 * publish/unlist endpoints move the status machine).
 */
export const ListingGroup = HttpApiGroup.make("listing-group")
  .add(
    HttpApiEndpoint.get("mine", "/mine", {
      query: ListingMineQuery,
      success: MyListingPageResponse,
      error: [UnauthorizedError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: CreateListingInput,
      success: ListingSchema,
      error: [
        UnauthorizedError,
        ListingValidationError,
        ListingLocationOutOfGreeceError,
        InternalError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: ListingId },
      payload: UpdateListingInput,
      success: ListingSchema,
      error: [
        ListingNotFoundError,
        ListingNotOwnedError,
        ListingValidationError,
        ListingLocationOutOfGreeceError,
        UnauthorizedError,
        InternalError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("publish", "/:id/publish", {
      params: { id: ListingId },
      success: ListingSchema,
      error: [
        ListingNotFoundError,
        ListingNotOwnedError,
        InvalidListingTransitionError,
        UnauthorizedError,
        InternalError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("unlist", "/:id/unlist", {
      params: { id: ListingId },
      success: ListingSchema,
      error: [
        ListingNotFoundError,
        ListingNotOwnedError,
        InvalidListingTransitionError,
        UnauthorizedError,
        InternalError,
      ],
    }),
  )
  .prefix("/listings");

/*
 * The contact path. A send names the listing in the path and carries only the
 * message; the sender is the session. Both lists are scoped by the caller's
 * account, so there is deliberately no endpoint that reads an enquiry by id -
 * that would be a cross-account read waiting to be written. A listing that is
 * not published answers the same 404 the public read does.
 */
export const EnquiryGroup = HttpApiGroup.make("enquiry-group")
  .add(
    HttpApiEndpoint.post("send", "/listings/:id/enquiries", {
      params: { id: ListingId },
      payload: SendEnquiryInput,
      success: EnquirySchema,
      error: [
        EnquiryListingNotFoundError,
        EnquiryOwnListingError,
        EnquiryValidationError,
        EnquiryRateLimitedError,
        UnauthorizedError,
        InternalError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("sent", "/enquiries/sent", {
      query: EnquiryPageQuery,
      success: SentEnquiryPage,
      error: [UnauthorizedError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("received", "/enquiries/received", {
      query: EnquiryPageQuery,
      success: ReceivedEnquiryPage,
      error: [UnauthorizedError, InternalError],
    }),
  );

// The api prefix only applies to the groups added before it.
export const PrivateApi = HttpApi.make("private-api")
  .add(UserGroup)
  .add(ListingGroup)
  .add(EnquiryGroup)
  .prefix("/api");

export const PrivateRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/private-get",
    HttpServerResponse.html(`
        <!doctype html>
        <html>
          <body>
            <h1>Hello Protected!</h1>
          </body>
        </html>
      `),
  ),
  ...ListingPageRoutes,
  ...ListingPhotoPageRoutes,
  ...ProfilePageRoutes,
  ...SavedSearchRoutes,
  ...EnquiryPageRoutes,
]);
