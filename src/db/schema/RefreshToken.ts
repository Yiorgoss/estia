import { RefreshTokenHash, RefreshTokenId, UserId } from "@/brands";
import { Schema } from "effect";


export interface RefreshToken extends Schema.Schema.Type<typeof RefreshTokenSchema> { }

export const RefreshTokenSchema = Schema.Struct({
  id: RefreshTokenId,
  userId: UserId,
  tokenHash: RefreshTokenHash,
  deviceInfo: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  expiresAt: Schema.Number,
  createdAt: Schema.Number,
  revokedAt: Schema.NullOr(Schema.Number),
})

export const NewRefreshToken = RefreshTokenSchema.pipe(
  Schema.pick(
    'userId',
    'tokenHash',
    'expiresAt',
    'deviceInfo'
  )
)
