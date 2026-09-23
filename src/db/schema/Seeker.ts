import { GenderEnum, SeekerId, UserId } from "@/db/schema/brands";
import { Schema } from "effect";


export const SeekerSchema = Schema.Struct({
  id: SeekerId,
  userId: UserId,
  name: Schema.String,
  bio: Schema.NullishOr(Schema.String),
  date_of_birth: Schema.DateFromNumber,
  gender: Schema.NullishOr(GenderEnum),
  picture: Schema.NullishOr(Schema.String),
  smoking: Schema.BooleanFromUnknown,
  pets: Schema.BooleanFromUnknown,
  createdAt: Schema.DateFromNumber,
})
