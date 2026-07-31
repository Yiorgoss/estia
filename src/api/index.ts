import { Layer, } from "effect";
import { PublicApi, PublicRoutes } from "./public"
import { HttpLayerRouter, } from "@effect/platform";
import { JWTServiceLive } from "@/services/jwt";
import { UserRepositoryLive } from "@/repo/user-repo";
import { RefreshTokenServiceLive } from "@/services/refresh-token";
import { RefreshTokenRepositoryLive } from "@/repo/refresh-token-repo";
import { UserServiceLive } from "@/services/user";
import { HasherServiceLive } from "@/services/hasher";
import { PublicApiLive } from "@/handlers/public/auth-handler";
import { AuthServiceLive } from "@/services/auth";
import { PrivateApi, PrivateRoutes } from "./private";
import { PrivateApiLive } from "@/handlers/private";
import { AuthMiddleware } from "@/middleware/auth-mw";
// import { AuthMiddlewareLive } from "@/middleware/auth-mw";

/*
 * PUBLIC API
 */

export const PublicApiRouterLive = HttpLayerRouter
  .addHttpApi(PublicApi)
  .pipe(
    Layer.provide(PublicApiLive),
  )

export const PublicRouterLive = Layer.mergeAll(
  PublicApiRouterLive,
  PublicRoutes,
).pipe(
  Layer.provide(UserServiceLive),
  Layer.provide(AuthServiceLive),
  Layer.provide(RefreshTokenServiceLive),
  Layer.provide(JWTServiceLive),
  Layer.provide(RefreshTokenRepositoryLive),
  Layer.provide(UserRepositoryLive),
  Layer.provide(HasherServiceLive),
)

/*
 * PRIVATE API
 */
export const PrivateApiRouterLive = HttpLayerRouter
  .addHttpApi(PrivateApi)
  .pipe(
    Layer.provide(PrivateApiLive),
  )

export const PrivateRouterLive = Layer.mergeAll(
  PrivateApiRouterLive,
  PrivateRoutes,
).pipe(
  Layer.provide(AuthMiddleware),
  Layer.provide(UserServiceLive),
  Layer.provide(AuthServiceLive),
  Layer.provide(RefreshTokenServiceLive),
  Layer.provide(JWTServiceLive),
  Layer.provide(RefreshTokenRepositoryLive),
  Layer.provide(UserRepositoryLive),
  Layer.provide(HasherServiceLive),
)
