import { ListerId, OwnershipEnum, UserId } from "@/db/schema/brands";
import { Schema } from "effect";


export const ListerSchema = Schema.Struct({
  id: ListerId,
  userId: UserId,
  picture: Schema.NullishOr(Schema.String),
  name: Schema.NullishOr(Schema.String),
  ownership: OwnershipEnum,
  createdAt: Schema.DateFromNumber
})
