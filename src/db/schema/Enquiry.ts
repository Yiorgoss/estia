import { EnquiryId, ListingId, UserId } from "@/db/schema/brands";
import { KeysetCursorFromString } from "@/db/schema/cursor";
import { Schema, SchemaTransformation } from "effect";

/*
 * An enquiry is the smallest record that closes the marketplace loop: one short
 * message from a signed-in seeker against one listing. The sender is the account
 * the session proves, never a request field, and there is no thread, no read
 * receipt, and no reply - the lister reads it and answers on the contact details
 * recorded with it.
 */

export const ENQUIRY_MESSAGE_MAX = 2000;

// A message is trimmed before it is bounded, so a padded message is stored
// trimmed and a whitespace-only one is rejected at the boundary instead of
// reaching the database CHECK.
export const EnquiryMessage = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(ENQUIRY_MESSAGE_MAX)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);

export const EnquirySchema = Schema.Struct({
  id: EnquiryId,
  listingId: ListingId,
  senderId: UserId,
  message: Schema.String,
  createdAt: Schema.DateFromMillis,
});
export type Enquiry = typeof EnquirySchema.Type;

// The JSON body of a send. Only the message is request data; the listing comes
// from the path and the sender from the session.
export const SendEnquiryInput = Schema.Struct({
  message: EnquiryMessage,
});
export type SendEnquiryInput = typeof SendEnquiryInput.Type;

/*
 * What the seeker sent. It carries the listing title so the list reads without a
 * second request, and no identity at all: the rows are already scoped to the
 * caller, so repeating their account id would only widen the wire shape.
 */
export const SentEnquiry = Schema.Struct({
  id: EnquiryId,
  listingId: ListingId,
  listingTitle: Schema.String,
  message: Schema.String,
  createdAt: Schema.DateFromMillis,
});
export type SentEnquiry = typeof SentEnquiry.Type;

export const ENQUIRY_PAGE_SIZE = 25;

export const SentEnquiryPage = Schema.Struct({
  items: Schema.Array(SentEnquiry),
  nextCursor: Schema.NullishOr(KeysetCursorFromString),
});
export type SentEnquiryPage = typeof SentEnquiryPage.Type;

/*
 * What the lister reads: the enquiry, the listing it belongs to, and who sent
 * it. The sender's display name and contact line are captured on the enquiry
 * when it is sent - the seeking profile's published values when they exist,
 * otherwise the account's stored email - so a later profile edit does not
 * rewrite what the lister was told. The sender's account id stays on the
 * server, so the lister cannot use this surface to reach anything else that
 * account holds.
 */
export const ReceivedEnquiry = Schema.Struct({
  id: EnquiryId,
  listingId: ListingId,
  listingTitle: Schema.String,
  senderName: Schema.String,
  senderContact: Schema.String,
  message: Schema.String,
  createdAt: Schema.DateFromMillis,
});
export type ReceivedEnquiry = typeof ReceivedEnquiry.Type;

export const ReceivedEnquiryPage = Schema.Struct({
  items: Schema.Array(ReceivedEnquiry),
  nextCursor: Schema.NullishOr(KeysetCursorFromString),
});
export type ReceivedEnquiryPage = typeof ReceivedEnquiryPage.Type;

// The JSON lists page with a single cursor; the server-rendered page pages its
// two lists independently, so it has one query field per list.
export const EnquiryPageQuery = Schema.Struct({
  cursor: Schema.optional(KeysetCursorFromString),
});
export type EnquiryPageQuery = typeof EnquiryPageQuery.Type;

export const EnquiriesPageQuery = Schema.Struct({
  receivedCursor: Schema.optional(KeysetCursorFromString),
  sentCursor: Schema.optional(KeysetCursorFromString),
  sent: Schema.optional(Schema.String),
});
export type EnquiriesPageQuery = typeof EnquiriesPageQuery.Type;

export const EnquiriesPageQueryCodec = Schema.toCodecStringTree(EnquiriesPageQuery);
