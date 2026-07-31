import { UserPasswordHash, UserId, UserRoles, JWTSchema } from "@/brands";
import { Context, Schema } from "effect";

export const UserSchema = Schema.Struct({
  id: UserId,
  email: Schema.String,
  passwordHash: UserPasswordHash,
  role: UserRoles,
  createdAt: Schema.DateFromNumber,
  updatedAt: Schema.DateFromNumber
});

export interface User extends Schema.Schema.Type<typeof UserSchema> { }


export const CurrentUser = UserSchema.pick("id", "role")

export class CurrentUserTag extends Context.Tag("CurrentUser")<
  typeof CurrentUser.Type,
  typeof CurrentUser.Type
>() { }

export const UserCredentials = Schema.Struct({
  email: Schema.String,
  password: Schema.String
})

export interface UserCredentialsType extends Schema.Schema.Type<typeof UserCredentials> { }

export const SuccessfulLogin = Schema.Struct({
  user: CurrentUser,
  token: JWTSchema
})

// export type UserLogin = Schema.Schema.Type<typeof UserLogin>

// export const NewUser = User.omit("id", "created_at", "updated_at")

// export interface User extends Schema.Schema.Type<typeof User> { }
// export interface NewUser extends Schema.Schema.Type<typeof User.omit("id", "created_at", "updated_at")> {}


