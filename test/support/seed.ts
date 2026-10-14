import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export const insertUser = (id: string, email: string, role: "admin" | "seeker" | "lister" | "user" = "user") =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [id, email, "hash", role],
    )
  })

export const insertLister = (
  id: number,
  userId: string,
  options: {
    readonly name?: string | null
    readonly ownership?: "owner" | "leaseholder"
    readonly picture?: string | null
  } = {},
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      "INSERT INTO listers (id, user_id, name, ownership, picture) VALUES (?, ?, ?, ?, ?)",
      [id, userId, options.name ?? "Lister", options.ownership ?? "owner", options.picture ?? null],
    )
  })

export const insertSeeker = (
  userId: string,
  options: {
    readonly name?: string
    readonly bio?: string | null
    readonly dateOfBirth?: number
    readonly gender?: "male" | "female" | "NB"
    readonly picture?: string | null
    readonly smoking?: boolean
    readonly pets?: boolean
  } = {},
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `INSERT INTO seekers (user_id, name, bio, date_of_birth, gender, picture, smoking, pets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        options.name ?? "Seeker",
        options.bio ?? null,
        options.dateOfBirth ?? 946684800000,
        options.gender ?? "NB",
        options.picture ?? null,
        options.smoking === true ? 1 : 0,
        options.pets === true ? 1 : 0,
      ],
    )
  })

export const insertRoom = (
  id: number,
  listerId: number,
  options: {
    readonly price?: number
    readonly location?: string
    readonly description?: string | null
    readonly size?: number | null
    readonly furnished?: boolean
    readonly ensuite?: boolean
    readonly smoking?: boolean
    readonly pets?: boolean
    readonly availableFrom?: number | null
  } = {},
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `INSERT INTO rooms (id, lister_id, price, location, description, size, furnished, ensuite, smoking, pets, available_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        listerId,
        options.price ?? 500,
        options.location ?? "Athens",
        options.description ?? null,
        options.size ?? null,
        options.furnished === true ? 1 : 0,
        options.ensuite === true ? 1 : 0,
        options.smoking === true ? 1 : 0,
        options.pets === true ? 1 : 0,
        options.availableFrom ?? null,
      ],
    )
  })

export const insertRefreshToken = (
  options: {
    readonly id?: string
    readonly userId: string
    readonly tokenHash: string
    readonly deviceInfo?: string | null
    readonly expiresAt?: number
    readonly revokedAt?: number | null
  },
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
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
    )
  })
