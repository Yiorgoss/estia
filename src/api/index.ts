import { Layer } from "effect";
import { PublicApi, PublicRoutes } from "./public"
import { HttpLayerRouter } from "@effect/platform";
import { JWTServiceLive } from "@/services/jwt";
import { UserRepositoryLive } from "@/repo/user-repo";
import { RefreshTokenServiceLive } from "@/services/refresh-token";
import { RefreshTokenRepositoryLive } from "@/repo/refresh-token-repo";
import { UserServiceLive } from "@/services/user";
import { HasherServiceLive } from "@/services/hasher";
import { PublicApiLive } from "@/handlers/public/auth-handler";
import { AuthServiceLive } from "@/services/auth";

// const Services = Layer.mergeAll(
//   RefreshTokenRepositoryLive,
//   UserRepositoryLive,
//   JWTServiceLive,
//   HasherServiceLive,
//   RefreshTokenServiceLive,
//   UserServiceLive,
//   AuthServiceLive,
// )

export const PublicApiRouterLive = HttpLayerRouter
  .addHttpApi(PublicApi)
  .pipe(
    Layer.provide(PublicApiLive),
  )

export const PublicRouterLive = Layer.mergeAll(
  PublicApiRouterLive,
  PublicRoutes,
)
  .pipe(
    Layer.provide(AuthServiceLive),
    Layer.provide(UserServiceLive),
    Layer.provide(UserRepositoryLive),
    Layer.provide(JWTServiceLive),
    Layer.provide(RefreshTokenServiceLive),
    Layer.provide(RefreshTokenRepositoryLive),
    Layer.provide(HasherServiceLive),
  )
