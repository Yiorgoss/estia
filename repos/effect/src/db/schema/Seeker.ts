import { GenderEnum, SeekerId, UserId } from "@/db/schema/brands";
import { Schema } from "effect";


export const SeekerSchema = Schema.Struct({
  id: SeekerId,
  userId: UserId,
  name: Schema.String,
  bio: Schema.NullishOr(Schema.String),
  dateOfBirth: Schema.DateFromMillis,
  gender: Schema.NullishOr(GenderEnum),
  picture: Schema.NullishOr(Schema.String),
  smoking: Schema.BooleanFromBit,
  pets: Schema.BooleanFromBit,
  createdAt: Schema.DateFromMillis,
})
