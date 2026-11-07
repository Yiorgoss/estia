import { ListerSchema } from "@/db/schema/Lister";
import { SeekerSchema } from "@/db/schema/Seeker";
import { ListingId } from "@/db/schema/brands";
import { CurrentUser } from "@/db/schema/User";
import { CreateListingInput, ListingSchema, UpdateListingInput } from "@/db/schema/Listing";
import { UnauthorizedError } from "@/services/auth.service";
import { InternalError } from "@/services/user.service";
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

export const UserGroup = HttpApiGroup.make("user-group")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: Schema.Struct({
        user: CurrentUser,
        userProfile: Schema.Union([SeekerSchema, ListerSchema]),
      }),
      error: [InternalError, UnauthorizedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("change-role", "/change-role", {
      success: Schema.Struct({
        newProfile: Schema.Union([SeekerSchema, ListerSchema]),
      }),
      error: [InternalError, UnauthorizedError],
    }),
  )
  // A group prefix only applies to the endpoints added before it.
  .prefix("/users");

/*
 * Owner-scoped listing writes. `ownerId`, `status`, and the timestamps are never
 * request data: the owner comes from the access token, a new listing is always a
 * draft, and only the publish/unlist endpoints move the status machine.
 */
export const ListingGroup = HttpApiGroup.make("listing-group")
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

// The api prefix only applies to the groups added before it.
export const PrivateApi = HttpApi.make("private-api")
  .add(UserGroup)
  .add(ListingGroup)
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
]);
