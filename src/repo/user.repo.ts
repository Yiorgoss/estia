import { Option, Context, Effect, Layer } from "effect"
import type { User } from "@/db/schema/User"
import { SqlClient, SqlError } from "@effect/sql";
import { UserId, UserPasswordHash, UserRoles } from "@/db/schema/brands";


export interface UserRepository {
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>, SqlError.SqlError>;
  readonly findById: (id: number | typeof UserId.Type) => Effect.Effect<Option.Option<User>, SqlError.SqlError>;
  readonly insert: (creds: { email: string, password: typeof UserPasswordHash.Type }) => Effect.Effect<Option.Option<User>, SqlError.SqlError>;
  readonly updateRole: (id: typeof UserId.Type, role: typeof UserRoles.Type) => Effect.Effect<Option.Option<User>, SqlError.SqlError>;
}

export const UserRepository = Context.GenericTag<UserRepository>("UserRepository");

export const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    return {
      findByEmail: (email: string) =>
        sql<User> `
            SELECT *
              FROM users
             WHERE email=${email}
            `
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullable)
          ),
      findById: (id) =>
        sql<User> `
            SELECT *
              FROM users
             WHERE id=${id}
            `
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullable)
          ),
      insert: ({ email, password }) =>
        sql<User> `
          INSERT INTO users (email, password_hash)
               VALUES (${email}, ${password})
            RETURNING *`
          .pipe(
            Effect.map(rows => rows[0]),
            Effect.map(Option.fromNullable)
          ),
      updateRole: (id, role) =>
        sql<User> `
              UPDATE users
                 SET role=${role}
               WHERE id = ${id}
           RETURNING *`
          .pipe(
            Effect.map(row => row[0]),
            Effect.map(Option.fromNullable)
          )
    } satisfies UserRepository // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError(error =>
      Effect.sync(() =>
        Effect.logError("User repository failed", { error })
      )
    )
  )
)
