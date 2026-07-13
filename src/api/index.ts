import { Layer } from "effect";
import { PublicApi, PublicRoutes } from "./public"
import { PublicApiLive } from "@/handlers/public/login-handler";
import { HttpLayerRouter } from "@effect/platform";
import { JWTLive } from "@/services/jwt";

export const PublicApiRouter = HttpLayerRouter
  .addHttpApi(PublicApi)
  .pipe(
    Layer.provide(PublicApiLive),
  )

export const PublicRouter = Layer.mergeAll(
  PublicApiRouter,
  PublicRoutes,
).pipe(
  Layer.provide(JWTLive),
)
