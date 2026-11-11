import { ListingId, UserId } from "@/db/schema/brands";
import type { KeysetCursor } from "@/db/schema/cursor";
import {
  ENQUIRY_PAGE_SIZE,
  EnquirySchema,
  ReceivedEnquiry,
  ReceivedEnquiryPage,
  SentEnquiry,
  SentEnquiryPage,
} from "@/db/schema/Enquiry";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/*
 * The enquiries repository. Every read is scoped in SQL by the account the
 * service passes - the sender for the sent list, the listing owner for the
 * received list - so no query can answer with another account's rows, and the
 * per-sender count the rate limit reads is the same scope.
 *
 * Repositories fail only with `SqlError`; domain errors belong to the service.
 */
export interface EnquiryRepository {
  readonly create: (
    listingId: typeof ListingId.Type,
    senderId: typeof UserId.Type,
    message: string,
    senderName: string,
    senderContact: string,
  ) => Effect.Effect<typeof EnquirySchema.Type, SqlError>;

  readonly listBySender: (
    senderId: typeof UserId.Type,
    cursor: KeysetCursor | undefined,
  ) => Effect.Effect<typeof SentEnquiryPage.Type, SqlError>;

  readonly listByOwner: (
    ownerId: typeof UserId.Type,
    cursor: KeysetCursor | undefined,
  ) => Effect.Effect<typeof ReceivedEnquiryPage.Type, SqlError>;

  readonly countRecentBySender: (
    senderId: typeof UserId.Type,
    since: number,
  ) => Effect.Effect<number, SqlError>;
}

export const EnquiryRepository = Context.Service<EnquiryRepository>("EnquiryRepository");

const decodeEnquiry = (row: Record<string, unknown>): typeof EnquirySchema.Type =>
  Schema.decodeUnknownSync(EnquirySchema)(row);

const decodeSent = (row: Record<string, unknown>): typeof SentEnquiry.Type =>
  Schema.decodeUnknownSync(SentEnquiry)(row);

const decodeReceived = (row: Record<string, unknown>): typeof ReceivedEnquiry.Type =>
  Schema.decodeUnknownSync(ReceivedEnquiry)(row);

// Fetch one extra row to learn whether another page exists without a `COUNT`.
const toPage = <Item extends { readonly createdAt: Date; readonly id: number }>(
  rows: ReadonlyArray<Record<string, unknown>>,
  decode: (row: Record<string, unknown>) => Item,
): { readonly items: ReadonlyArray<Item>; readonly nextCursor: KeysetCursor | null } => {
  const hasMore = rows.length > ENQUIRY_PAGE_SIZE;
  const items = (hasMore ? rows.slice(0, ENQUIRY_PAGE_SIZE) : rows).map(decode);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last !== undefined ? { createdAt: last.createdAt.getTime(), id: last.id } : null,
  };
};

export const EnquiryRepositoryLive = Layer.effect(
  EnquiryRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Keyset predicate for the deterministic `(created_at DESC, id DESC)` sort.
    // Both tables in the joins carry these columns, so the enquiry's own alias is
    // named and the cursor can never move the window by a listing timestamp.
    const cursorClause = (cursor: KeysetCursor | undefined) =>
      cursor === undefined
        ? sql``
        : sql`AND (e.created_at < ${cursor.createdAt} OR (e.created_at = ${cursor.createdAt} AND e.id < ${cursor.id}))`;

    return {
      create: (listingId, senderId, message, senderName, senderContact) =>
        sql<Record<string, unknown>>`
            INSERT INTO enquiries (listing_id, sender_id, message, sender_name, sender_contact)
                 VALUES (${listingId}, ${senderId}, ${message}, ${senderName}, ${senderContact})
             RETURNING id, listing_id, sender_id, message, created_at;`.pipe(
          Effect.map((rows) => decodeEnquiry(Option.getOrThrow(Option.fromNullishOr(rows[0])))),
        ),
      listBySender: (senderId, cursor) =>
        sql<Record<string, unknown>>`
            SELECT e.id,
                   e.listing_id,
                   l.title AS listing_title,
                   e.message,
                   e.created_at
              FROM enquiries e
              JOIN listings l ON l.id = e.listing_id
             WHERE e.sender_id = ${senderId}
                 ${cursorClause(cursor)}
          ORDER BY e.created_at DESC, e.id DESC
             LIMIT ${ENQUIRY_PAGE_SIZE + 1}
            `.pipe(Effect.map((rows) => toPage(rows, decodeSent))),
      listByOwner: (ownerId, cursor) =>
        // The identity is the snapshot written when the enquiry was sent, never
        // a live profile read, so a later profile edit cannot rewrite the record.
        sql<Record<string, unknown>>`
            SELECT e.id,
                   e.listing_id,
                   l.title AS listing_title,
                   e.sender_name,
                   e.sender_contact,
                   e.message,
                   e.created_at
              FROM enquiries e
              JOIN listings l ON l.id = e.listing_id
             WHERE l.owner_id = ${ownerId}
                 ${cursorClause(cursor)}
          ORDER BY e.created_at DESC, e.id DESC
             LIMIT ${ENQUIRY_PAGE_SIZE + 1}
            `.pipe(Effect.map((rows) => toPage(rows, decodeReceived))),
      countRecentBySender: (senderId, since) =>
        sql<Record<string, unknown>>`
            SELECT COUNT(*) AS total
              FROM enquiries
             WHERE sender_id = ${senderId}
               AND created_at >= ${since}
            `.pipe(Effect.map((rows) => Number(rows[0]?.["total"] ?? 0))),
    } satisfies EnquiryRepository;
  }).pipe(Effect.tapError((error) => Effect.logError("Enquiry repository failed", { error }))),
);
