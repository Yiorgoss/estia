import { UserId, UserPasswordHash, UserRoles } from "@/db/schema/brands";
import { UserSchema, type User } from "@/db/schema/User";
import { decodeRow, query, type RepositoryError } from "@/repos/errors";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

export interface UserRepository {
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>, RepositoryError>;
  readonly findById: (
    id: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<User>, RepositoryError>;
  readonly insert: (creds: {
    email: string;
    password: typeof UserPasswordHash.Type;
    role: typeof UserRoles.Type;
  }) => Effect.Effect<Option.Option<User>, RepositoryError>;
  readonly updateRole: (
    id: typeof UserId.Type,
    role: typeof UserRoles.Type,
  ) => Effect.Effect<Option.Option<User>, RepositoryError>;
  /*
   * Remove an account. Every profile, token, and listing the account owns
   * references `users(id) ON DELETE CASCADE`, so the row is the only thing to
   * delete and the rest goes with it.
   */
  readonly deleteById: (id: typeof UserId.Type) => Effect.Effect<void, RepositoryError>;
}

export const UserRepository = Context.Service<UserRepository>("UserRepository");

export const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      findByEmail: (email: string) =>
        query(
          "UserRepository.findByEmail",
          sql<Record<string, unknown>>`
            SELECT *
              FROM users
             WHERE email=${email}
            `,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow("UserRepository.findByEmail", UserSchema, rows[0]).pipe(
                  Effect.map(Option.some),
                ),
          ),
        ),
      findById: (id) =>
        query(
          "UserRepository.findById",
          sql<Record<string, unknown>>`
            SELECT *
              FROM users
             WHERE id=${id}
            `,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow("UserRepository.findById", UserSchema, rows[0]).pipe(
                  Effect.map(Option.some),
                ),
          ),
        ),
      insert: ({ email, password, role }) =>
        query(
          "UserRepository.insert",
          sql<Record<string, unknown>>`
          INSERT INTO users (email, password_hash, role)
               VALUES (${email}, ${password}, ${role})
            RETURNING *;`,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow("UserRepository.insert", UserSchema, rows[0]).pipe(
                  Effect.map(Option.some),
                ),
          ),
        ),
      updateRole: (id, role) =>
        query(
          "UserRepository.updateRole",
          sql<Record<string, unknown>>`
              UPDATE users
                 SET role=${role}
               WHERE id=${id}
           RETURNING *;`,
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeedNone
              : decodeRow("UserRepository.updateRole", UserSchema, rows[0]).pipe(
                  Effect.map(Option.some),
                ),
          ),
        ),
      deleteById: (id) =>
        query(
          "UserRepository.deleteById",
          sql`
          DELETE FROM users
           WHERE id = ${id};`,
        ).pipe(Effect.asVoid),
    } satisfies UserRepository;
  }),
);
