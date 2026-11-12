import { Layer } from "effect";
import { PublicApi, PublicRoutes } from "./public";
import { MapBasemapUrlLive } from "./map-tiles";
import { HttpApiBuilder } from "effect/http-api";
import { JWTServiceLive } from "@/services/jwt.service";
import { UserRepositoryLive } from "@/repos/user.repo";
import { RefreshTokenServiceLive } from "@/services/refresh-token.service";
import { RefreshTokenRepositoryLive } from "@/repos/refresh-token.repo";
import { UserServiceLive } from "@/services/user.service";
import { HasherServiceLive } from "@/services/hasher.service";
import { PublicApiLive } from "@/handlers/public/auth-handler";
import { AuthServiceLive } from "@/services/auth.service";
import { PrivateApi, PrivateRoutes } from "./private";
import { AuthMiddleware } from "@/middleware/auth-mw";
import { SameOriginWriteMiddleware } from "@/handlers/same-origin";
import { SeekerRepositoryLive } from "@/repos/seeker.repo";
import { ListerRepositoryLive } from "@/repos/lister.repo";
import { ListingRepositoryLive } from "@/repos/listing.repo";
import { SavedSearchRepositoryLive } from "@/repos/saved-search.repo";
import { UserHandler } from "@/handlers/private/user.handler";
import { ListingHandler as PrivateListingHandler } from "@/handlers/private/listing.handler";
import { ListingServiceLive } from "@/services/listing.service";
import { SavedSearchServiceLive } from "@/services/saved-search.service";
import { ListingHandler as PublicListingHandler } from "@/handlers/public/listing.handler";

// --- Repositories ---
export const RepositoriesLive = Layer.mergeAll(
  ListerRepositoryLive,
  SeekerRepositoryLive,
  RefreshTokenRepositoryLive,
  UserRepositoryLive,
  ListingRepositoryLive,
  SavedSearchRepositoryLive,
);

// --- Low-level / infra services ---
export const InfraServicesLive = Layer.mergeAll(HasherServiceLive, JWTServiceLive);

// --- Domain services (depend on repos + infra) ---
export const DomainServicesLive = Layer.mergeAll(
  UserServiceLive,
  RefreshTokenServiceLive,
  ListingServiceLive,
  SavedSearchServiceLive,
);

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
  Layer.provide(Layer.mergeAll(PublicApiLive, PublicListingHandler)),
);

export const PublicRouterLive = Layer.mergeAll(
  PublicApiRouterLive,
  PublicRoutes,
  MapBasemapUrlLive,
);

/*
 * PRIVATE API
 */

export const PrivateApiRouterLive = HttpApiBuilder.layer(PrivateApi).pipe(
  Layer.provide(Layer.mergeAll(UserHandler, PrivateListingHandler)),
  Layer.provide(SameOriginWriteMiddleware),
);

export const PrivateRouterLive = Layer.mergeAll(PrivateApiRouterLive, PrivateRoutes).pipe(
  Layer.provide(AuthMiddleware),
);
