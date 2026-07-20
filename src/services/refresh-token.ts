import { RefreshTokenValue } from "@/db/schema/RefreshToken";
import { Context, Effect, Layer, Schema } from "effect";
import { HashError, HasherService } from "./hasher";
import { RefreshTokenRepository } from "@/repo/refresh-token-repo";


export class RefreshTokenServiceError extends Schema.TaggedError<RefreshTokenServiceError>()(
  "RefreshTokenServiceError",
  {},) { }

export interface RefreshTokenService {
  create: (id: number) =>
    Effect.Effect<typeof RefreshTokenValue.Type, HashError | RefreshTokenServiceError>;
  // hash: (token: typeof RefreshTokenValue.Type) =>
  //   Effect.Effect<RefreshToken, RefreshTokenServiceError | HashError>;
  // revoke: () =>
  //   Effect.Effect<object, RefreshTokenServiceError>;
}
export const RefreshTokenService = Context.GenericTag<RefreshTokenService>("RefreshTokenService");

export const RefreshTokenServiceLive = Layer.effect(
  RefreshTokenService,
  Effect.gen(function*() {
    // const domain = yield* Config.string("DOMAIN")

    const refreshTokenRepo = yield* RefreshTokenRepository
    const hasher = yield* HasherService
    return {
      create: (id) =>
        Effect.gen(function*() {
          const token = Schema.decodeSync(RefreshTokenValue)(
            crypto.getRandomValues(new Uint8Array(32)).toHex())
          const hash = yield* hasher.hashRefreshToken(token)

          yield* refreshTokenRepo
            .new({ userId: id, tokenHash: hash, expiresAt: Date.now() })

          return token
        })
          .pipe(
            Effect.catchTags({
              SqlError: () => Effect.fail(new RefreshTokenServiceError())
            })
          ),
      // hash: (token) => hasher.hashRefreshToken(token),
      // revoke: () => Effect.dieMessage("todo: implement hash"),
    }
  })
)
