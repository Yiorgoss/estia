import { GenderEnum, SeekerId, UserId } from "@/db/schema/brands";
import { Schema } from "effect";

/*
 * A seeking profile is opened from the user id alone at registration, so the
 * fields a person fills in themselves - name, date of birth, gender - are
 * nullish until they do. The bits and the timestamps always have a value.
 */
export const SeekerSchema = Schema.Struct({
  id: SeekerId,
  userId: UserId,
  name: Schema.NullishOr(Schema.String),
  // The contact line this person chose to publish, or null when they have not.
  contact: Schema.NullishOr(Schema.String),
  bio: Schema.NullishOr(Schema.String),
  dateOfBirth: Schema.NullishOr(Schema.DateFromMillis),
  gender: Schema.NullishOr(GenderEnum),
  smoking: Schema.BooleanFromBit,
  pets: Schema.BooleanFromBit,
  createdAt: Schema.DateFromMillis,
});
