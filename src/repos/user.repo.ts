import { Option, Context, Effect, Layer, Schema } from "effect";
import { UserSchema, type User } from "@/db/schema/User";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { UserId, UserPasswordHash, UserRoles } from "@/db/schema/brands";

// The driver returns raw rows (`created_at`/`updated_at` as epoch millis), so
// every row is decoded through `UserSchema` to yield the declared `Date`s.
const decodeUser = (row: Record<string, unknown>): User =>
  Schema.decodeUnknownSync(UserSchema)(row);

export interface UserRepository {
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>, SqlError>;
  readonly findById: (id: typeof UserId.Type) => Effect.Effect<Option.Option<User>, SqlError>;
  readonly insert: (creds: {
    email: string;
    password: typeof UserPasswordHash.Type;
    role: typeof UserRoles.Type;
  }) => Effect.Effect<Option.Option<User>, SqlError>;
  readonly updateRole: (
    id: typeof UserId.Type,
    role: typeof UserRoles.Type,
  ) => Effect.Effect<Option.Option<User>, SqlError>;
  readonly updateAvatar: (id: typeof UserId.Type, avatar: string) => Effect.Effect<void, SqlError>;
  /*
   * Remove an account. Every profile, token, and listing the account owns
   * references `users(id) ON DELETE CASCADE`, so the row is the only thing to
   * delete and the rest goes with it.
   */
  readonly deleteById: (id: typeof UserId.Type) => Effect.Effect<void, SqlError>;
}

export const UserRepository = Context.Service<UserRepository>("UserRepository");

export const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      findByEmail: (email: string) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM users
             WHERE email=${email}
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeUser)),
        ),
      findById: (id) =>
        sql<Record<string, unknown>>`
            SELECT *
              FROM users
             WHERE id=${id}
            `.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeUser)),
        ),
      insert: ({ email, password, role }) =>
        sql<Record<string, unknown>>`
          INSERT INTO users (email, password_hash, role)
               VALUES (${email}, ${password}, ${role})
            RETURNING *;`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeUser)),
        ),
      updateRole: (id, role) =>
        sql<Record<string, unknown>>`
              UPDATE users
                 SET role=${role}
               WHERE id=${id}
           RETURNING *;`.pipe(
          Effect.map((row) => row[0]),
          Effect.map(Option.fromNullishOr),
          Effect.map(Option.map(decodeUser)),
        ),
      updateAvatar: (id, avatar) =>
        sql<typeof UserId.Type>`
          UPDATE users
             SET avatar=${avatar}
           WHERE id=${id};
       RETURNING id;`.pipe(
          Effect.map((row) => row[0]),
          Effect.map(Option.fromNullishOr),
        ),
      deleteById: (id) =>
        sql`
          DELETE FROM users
           WHERE id = ${id};`.pipe(Effect.asVoid),
    } satisfies UserRepository; // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => Effect.logError("User repository failed", { error })),
    ),
  ),
);
