import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export const insertUser = (
  id: string,
  email: string,
  role: "admin" | "seeker" | "lister" | "user" = "user",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)", [
      id,
      email,
      "hash",
      role,
    ]);
  });

export const insertLister = (
  id: number,
  userId: string,
  options: {
    readonly name?: string | null;
    readonly ownership?: "owner" | "leaseholder";
    readonly contact?: string | null;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const name = options.name === undefined ? "Lister" : options.name;
    yield* sql.unsafe(
      "INSERT INTO listers (id, user_id, name, ownership, contact) VALUES (?, ?, ?, ?, ?)",
      [id, userId, name, options.ownership ?? "owner", options.contact ?? null],
    );
  });

export const insertSeeker = (
  userId: string,
  options: {
    readonly name?: string;
    readonly bio?: string | null;
    readonly dateOfBirth?: number;
    readonly gender?: "male" | "female" | "NB";
    readonly smoking?: boolean;
    readonly pets?: boolean;
    readonly contact?: string | null;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `INSERT INTO seekers (user_id, name, bio, date_of_birth, gender, smoking, pets, contact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        options.name ?? "Seeker",
        options.bio ?? null,
        options.dateOfBirth ?? 946684800000,
        options.gender ?? "NB",
        options.smoking === true ? 1 : 0,
        options.pets === true ? 1 : 0,
        options.contact ?? null,
      ],
    );
  });

export const insertListing = (
  id: number,
  ownerId: string,
  options: {
    readonly kind?: "room" | "whole_property" | "room_wanted";
    readonly status?: "draft" | "published" | "unpublished";
    readonly title?: string;
    readonly description?: string | null;
    readonly priceMinor?: number;
    readonly regionCode?: string;
    readonly lat?: number | null;
    readonly lng?: number | null;
    readonly sizeSqm?: number | null;
    readonly availableFrom?: number | null;
    readonly furnished?: boolean;
    readonly ensuite?: boolean;
    readonly smoking?: boolean;
    readonly pets?: boolean;
    readonly createdAt?: number;
    readonly updatedAt?: number;
    readonly publishedAt?: number | null;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = options.createdAt ?? 1_700_000_000_000;
    const status = options.status ?? "draft";
    yield* sql.unsafe(
      `INSERT INTO listings (id, kind, owner_id, status, title, description, price_minor, currency,
                             region_code, lat, lng, size_sqm, available_from, furnished, ensuite,
                             smoking, pets, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.kind ?? "room",
        ownerId,
        status,
        options.title ?? "A listing",
        options.description ?? null,
        options.priceMinor ?? 50_000,
        "EUR",
        options.regionCode ?? "attica",
        options.lat ?? null,
        options.lng ?? null,
        options.sizeSqm ?? null,
        options.availableFrom ?? null,
        options.furnished === true ? 1 : 0,
        options.ensuite === true ? 1 : 0,
        options.smoking === true ? 1 : 0,
        options.pets === true ? 1 : 0,
        createdAt,
        options.updatedAt ?? createdAt,
        options.publishedAt ?? (status === "published" ? createdAt : null),
      ],
    );
  });

export const insertEnquiry = (options: {
  readonly listingId: number;
  readonly senderId: string;
  readonly senderName: string;
  readonly senderContact: string;
  readonly message?: string;
  readonly createdAt?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `INSERT INTO enquiries (listing_id, sender_id, message, sender_name, sender_contact, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        options.listingId,
        options.senderId,
        options.message ?? "Is this still available?",
        options.senderName,
        options.senderContact,
        options.createdAt ?? 1_700_000_000_000,
      ],
    );
  });

export const insertRefreshToken = (options: {
  readonly id?: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly deviceInfo?: string | null;
  readonly expiresAt?: number;
  readonly revokedAt?: number | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, device_info, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        options.id ?? options.tokenHash,
        options.userId,
        options.tokenHash,
        options.deviceInfo ?? null,
        options.expiresAt ?? 3_600_000,
        options.revokedAt ?? null,
      ],
    );
  });

export const insertListingPhoto = (
  id: number,
  listingId: number,
  options: {
    readonly storageKey?: string;
    readonly contentType?: "image/jpeg" | "image/png" | "image/webp";
    readonly byteSize?: number;
    readonly thumbnailKey?: string | null;
    readonly position?: number;
    readonly createdAt?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `INSERT INTO listing_photos (id, listing_id, storage_key, content_type, byte_size, thumbnail_key, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        listingId,
        options.storageKey ?? `listings/${listingId}/photos/${id}.jpg`,
        options.contentType ?? "image/jpeg",
        options.byteSize ?? 3,
        options.thumbnailKey ?? null,
        options.position ?? 0,
        options.createdAt ?? 1_700_000_000_000,
      ],
    );
  });
