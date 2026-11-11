import { ListerId, OwnershipEnum, UserId } from "@/db/schema/brands";
import { Schema } from "effect";

export const ListerSchema = Schema.Struct({
  id: ListerId,
  userId: UserId,
  name: Schema.NullishOr(Schema.String),
  // The contact line this lister chose to publish, or null when they have not.
  contact: Schema.NullishOr(Schema.String),
  ownership: OwnershipEnum,
  createdAt: Schema.DateFromMillis,
});
