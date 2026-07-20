import { PublicApi } from "@/api/public";
import { RefreshTokenRepositoryLive } from "@/repo/refresh-token-repo";
import { UserRepositoryLive } from "@/repo/user-repo";
import { AuthService, AuthServiceLive } from "@/services/auth";
import { HasherServiceLive } from "@/services/hasher";
import { JWTServiceLive } from "@/services/jwt";
import { RefreshTokenServiceLive } from "@/services/refresh-token";
import { UserService, UserServiceLive } from "@/services/user";
import { HttpApiBuilder } from "@effect/platform";
import { Effect, Layer } from "effect";


export const PublicApiLive = HttpApiBuilder.group(
  PublicApi,
  'auth',
  (handlers) =>
    handlers
      .handle('login', (req) =>
        Effect.gen(function*() {
          //validate user
          const { email, password } = req.payload

          const authService = yield* AuthService
          const tokens = yield* authService.login({ email, password })

          return tokens
        })
      )
      .handle('register', (req) =>
        Effect.gen(function*() {
          const { email, password } = req.payload
          const userService = yield* UserService
          const tokens = yield* userService.registerUser({ email, password })

          return tokens
        })
      )
)
// .pipe(
//   Layer.provide(AuthServiceLive),
//   Layer.provide(UserServiceLive),
//   Layer.provide(UserRepositoryLive),
//   Layer.provide(JWTServiceLive),
//   Layer.provide(RefreshTokenServiceLive),
//   Layer.provide(RefreshTokenRepositoryLive),
//   Layer.provide(HasherServiceLive),
// )
