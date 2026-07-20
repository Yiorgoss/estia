import { Schema } from "effect";


export interface RefreshToken extends Schema.Schema.Type<typeof RefreshTokenSchema> { }

export const RefreshTokenValue = Schema.String.pipe(Schema.brand("RefreshTokenValue"))

export const RefreshTokenHash = Schema.String.pipe(Schema.brand("RefreshTokenHash"))

export const RefreshTokenSchema = Schema.Struct({
  id: Schema.Number,
  userId: Schema.Number,
  tokenHash: RefreshTokenHash,
  deviceInfo: Schema.optional(Schema.String),
  ipAddress: Schema.optional(Schema.String),
  expiresAt: Schema.Number,
  createdAt: Schema.Number,
  revokedAt: Schema.optional(Schema.Number),
})

export const NewRefreshToken = RefreshTokenSchema.pipe(Schema.pick('userId', 'tokenHash', 'expiresAt'))
