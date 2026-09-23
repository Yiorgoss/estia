import { Layer, } from "effect";
import { PublicApi, PublicRoutes } from "./public"
import { HttpLayerRouter, } from "@effect/platform";
import { JWTServiceLive } from "@/services/jwt.service";
import { UserRepositoryLive } from "@/repo/user.repo";
import { RefreshTokenServiceLive } from "@/services/refresh-token.service";
import { RefreshTokenRepositoryLive } from "@/repo/refresh-token.repo";
import { UserServiceLive } from "@/services/user.service";
import { HasherServiceLive } from "@/services/hasher.service";
import { PublicApiLive } from "@/handlers/public/auth-handler";
import { AuthServiceLive } from "@/services/auth.service";
import { PrivateApi, PrivateRoutes } from "./private";
import { AuthMiddleware } from "@/middleware/auth-mw";
import { SeekerRepositoryLive } from "@/repo/seeker.repo";
import { ListerRepositoryLive } from "@/repo/lister.repo";
import { UserHandler } from "@/handlers/private/user.handler";

// --- Repositories ---
export const RepositoriesLive = Layer.mergeAll(
  ListerRepositoryLive,
  SeekerRepositoryLive,
  RefreshTokenRepositoryLive,
  UserRepositoryLive,
)

// --- Low-level / infra services ---
export const InfraServicesLive = Layer.mergeAll(
  HasherServiceLive,
  JWTServiceLive
)

// --- Domain services (depend on repos + infra) ---
export const DomainServicesLive = Layer.mergeAll(
  UserServiceLive,
  RefreshTokenServiceLive
)

// --- Final app layer ---
export const AppLive = Layer.mergeAll(
  AuthServiceLive
)

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
)

/*
 * PRIVATE API
 */

export const PrivateApiRouterLive = HttpLayerRouter
  .addHttpApi(PrivateApi)
  .pipe(
    Layer.provide(UserHandler),
  )

export const PrivateRouterLive = Layer.mergeAll(
  PrivateApiRouterLive,
  PrivateRoutes,
).pipe(
  Layer.provide(AuthMiddleware),
)
