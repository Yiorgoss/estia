import { UserPasswordHash, UserId, UserRoles, JWTSchema } from "@/db/schema/brands";
import { Context, Schema, Struct } from "effect";

export const UserSchema = Schema.Struct({
  id: UserId,
  email: Schema.String,
  passwordHash: UserPasswordHash,
  role: UserRoles,
  createdAt: Schema.DateFromMillis,
  updatedAt: Schema.DateFromMillis,
});

export interface User extends Schema.Schema.Type<typeof UserSchema> {}

export const CurrentUser = UserSchema.mapFields(Struct.pick(["id", "role"]));

export class CurrentUserTag extends Context.Service<CurrentUserTag, typeof CurrentUser.Type>()(
  "CurrentUser",
) {}

export const UserCredentials = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
});

export interface UserCredentialsType extends Schema.Schema.Type<typeof UserCredentials> {}

export const SuccessfulLogin = Schema.Struct({
  user: CurrentUser,
  token: JWTSchema,
});

// export type UserLogin = Schema.Schema.Type<typeof UserLogin>

// export const NewUser = User.omit("id", "created_at", "updated_at")

// export interface User extends Schema.Schema.Type<typeof User> { }
// export interface NewUser extends Schema.Schema.Type<typeof User.omit("id", "created_at", "updated_at")> { }
