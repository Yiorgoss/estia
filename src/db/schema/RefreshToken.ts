import { Schema } from "effect";


export interface RefreshToken extends Schema.Schema.Type<typeof RefreshTokenSchema> { }

export const RefreshTokenValue = Schema.String.pipe(Schema.brand("RefreshTokenValue"))

export const RefreshTokenHash = Schema.String.pipe(Schema.brand("RefreshTokenHash"))

export const RefreshTokenSchema = Schema.Struct({
  id: Schema.Number,
  userId: Schema.Number,
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
