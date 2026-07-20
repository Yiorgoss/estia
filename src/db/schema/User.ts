import { JWTSchema } from "@/services/jwt";
import { Schema } from "effect";

export const PasswordHash = Schema.String.pipe(Schema.brand("PasswordHash"))

export const UserSchema = Schema.Struct({
  id: Schema.Number,
  email: Schema.String,
  passwordHash: PasswordHash,
  role: Schema.Literal("user", "owner", "admin"),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.Date
});

export interface User extends Schema.Schema.Type<typeof UserSchema> { }


export const UserActive = UserSchema.omit("createdAt", "updatedAt", "passwordHash")

export const UserCredentials = Schema.Struct({
  email: Schema.String,
  password: Schema.String
})

export interface UserCredentialsType extends Schema.Schema.Type<typeof UserCredentials> { }

export const SuccessfulLogin = Schema.Struct({
  user: UserActive,
  token: JWTSchema
})

// export type UserLogin = Schema.Schema.Type<typeof UserLogin>

// export const NewUser = User.omit("id", "created_at", "updated_at")

// export interface User extends Schema.Schema.Type<typeof User> { }
// export interface NewUser extends Schema.Schema.Type<typeof User.omit("id", "created_at", "updated_at")> {}


