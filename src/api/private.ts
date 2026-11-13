import { ListerSchema } from "@/db/schema/Lister";
import { SeekerSchema } from "@/db/schema/Seeker";
import { ProfileInput, RoleSwitchQuery } from "@/db/schema/Profile";
import { ChatId, ListingId, UserRoles } from "@/db/schema/brands";
import {
  ChatDetailSchema,
  ChatInboxSchema,
  ChatMessageSchema,
  ChatMessagesQuery,
  ChatMessagesSchema,
  ChatReadInput,
  ChatReadSchema,
  SendMessageInput,
} from "@/db/schema/Chat";
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
import {
  ChatNotFoundError,
  ChatRateLimitedError,
  ChatValidationError,
} from "@/services/chat.service";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Schema } from "effect";
import { ListingPageRoutes } from "@/handlers/private/listing-pages";
import { ListingPhotoPageRoutes } from "@/handlers/private/listing-photo-pages";
import { ProfilePageRoutes } from "@/handlers/private/profile-pages";
import { SavedSearchRoutes } from "@/handlers/private/saved-search-routes";
import { ChatPageRoutes } from "@/handlers/private/chat-pages";

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
 * The caller's chats. Every endpoint is scoped to the cookie: no request carries
 * a user id, the inbox is chosen by the caller's own participant row, and a chat
 * id the caller does not belong to is the same 404 as one that does not exist.
 *
 * `send` is the no-socket fallback. It posts to the chat object rather than
 * inserting a row here, so a message sent this way takes the next sequence number
 * exactly as a live socket send would.
 */
export const ChatGroup = HttpApiGroup.make("chat-group")
  .add(
    HttpApiEndpoint.get("inbox", "/", {
      success: ChatInboxSchema,
      error: [UnauthorizedError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/:id", {
      params: { id: ChatId },
      success: ChatDetailSchema,
      // Reading a chat is opening it, so the caller's read mark moves here and
      // the inbox badge for this thread clears.
      error: [ChatNotFoundError, UnauthorizedError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("messages", "/:id/messages", {
      params: { id: ChatId },
      query: ChatMessagesQuery,
      success: ChatMessagesSchema,
      error: [ChatNotFoundError, UnauthorizedError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("send", "/:id/messages", {
      params: { id: ChatId },
      payload: SendMessageInput,
      success: ChatMessageSchema,
      error: [
        ChatNotFoundError,
        ChatValidationError,
        ChatRateLimitedError,
        UnauthorizedError,
        InternalError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("read", "/:id/read", {
      params: { id: ChatId },
      payload: ChatReadInput,
      success: ChatReadSchema,
      error: [ChatNotFoundError, UnauthorizedError, InternalError],
    }),
  )
  // A group prefix only applies to the endpoints added before it.
  .prefix("/chats");

// The api prefix only applies to the groups added before it.
export const PrivateApi = HttpApi.make("private-api")
  .add(UserGroup)
  .add(ListingGroup)
  .add(ChatGroup)
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
  ...ChatPageRoutes,
]);
