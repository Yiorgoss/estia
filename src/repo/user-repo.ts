import { Context, Data, Effect, Layer, Schema } from "effect"
import type { User, UserLogin } from "@/db/schema/User"

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  reason: Schema.Literal("InvalidCredentials", "UserNotFound", "AccountDisabled", "Unknown"),
  cause: Schema.Unknown
}) { }

export interface UserRepositoryI {
  readonly findByEmail: (email: string) => Effect.Effect<User | null, Error>;
}

export const UserRepository = Context.GenericTag<UserRepositoryI>("UserRepository");

export const UserRepositoryLive = (db: D1Database): UserRepositoryI => ({
  findByEmail: (email: string) => Effect.tryPromise({
    try: async () => {
      const result = await db
        .prepare("SELECT * FROM users WHERE email = ? LIMIT 1")
        .bind(email)
        .first<User>();
      return result || null;
    },
    catch: (error) => {
      return new AuthError({
        reason: "Unknown",
        cause: error
      })
    }
  })
})
