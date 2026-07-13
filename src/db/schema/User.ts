import { Schema } from "effect";

export const User = Schema.Struct({
  id: Schema.Number,
  name: Schema.NonEmptyString,
  age: Schema.Number,
  email: Schema.String,
  created_at: Schema.DateFromString,
  updated_at: Schema.Date
});

export type User = Schema.Schema.Type<typeof User>

export const UserLogin = Schema.Struct({
  email: Schema.NonEmptyString,
  password: Schema.NonEmptyString
})

export type UserLogin = Schema.Schema.Type<typeof UserLogin>

export const NewUser = User.omit("id", "created_at", "updated_at")

// export interface User extends Schema.Schema.Type<typeof User> { }
// export interface NewUser extends Schema.Schema.Type<typeof User.omit("id", "created_at", "updated_at")> {}


