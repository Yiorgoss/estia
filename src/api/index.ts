import { Layer } from "effect";
import { PublicApi, PublicRoutes } from "./public";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
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
import { RoomRepositoryLive } from "@/repo/room.repo";
import { UserHandler } from "@/handlers/private/user.handler";
import { RoomHandler } from "@/handlers/private/room.handler";

// --- Repositories ---
export const RepositoriesLive = Layer.mergeAll(
  ListerRepositoryLive,
  SeekerRepositoryLive,
  RefreshTokenRepositoryLive,
  UserRepositoryLive,
  RoomRepositoryLive,
);

// --- Low-level / infra services ---
export const InfraServicesLive = Layer.mergeAll(HasherServiceLive, JWTServiceLive);

// --- Domain services (depend on repos + infra) ---
export const DomainServicesLive = Layer.mergeAll(UserServiceLive, RefreshTokenServiceLive);

// --- Final app layer ---
export const AppLive = Layer.mergeAll(AuthServiceLive);

// --- Fully wired application services (only `SqlClient` is left to provide) ---
const RepositoriesFully = RepositoriesLive;
const InfraServicesFully = InfraServicesLive;
const DomainServicesFully = DomainServicesLive.pipe(
  Layer.provide(RepositoriesFully),
  Layer.provide(InfraServicesFully),
);
const AppFully = AppLive.pipe(
  Layer.provide(DomainServicesFully),
  Layer.provide(RepositoriesFully),
  Layer.provide(InfraServicesFully),
);
export const AppServicesLive = Layer.mergeAll(
  AppFully,
  DomainServicesFully,
  InfraServicesFully,
  RepositoriesFully,
);

/*
 * PUBLIC API
 */

export const PublicApiRouterLive = HttpApiBuilder.layer(PublicApi).pipe(
  Layer.provide(PublicApiLive),
);

export const PublicRouterLive = Layer.mergeAll(PublicApiRouterLive, PublicRoutes);

/*
 * PRIVATE API
 */

export const PrivateApiRouterLive = HttpApiBuilder.layer(PrivateApi).pipe(
  Layer.provide(Layer.mergeAll(UserHandler, RoomHandler)),
);

export const PrivateRouterLive = Layer.mergeAll(PrivateApiRouterLive, PrivateRoutes).pipe(
  Layer.provide(AuthMiddleware),
);
