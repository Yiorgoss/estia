import { HttpLayerRouter, HttpServerResponse } from "@effect/platform";

export const HealthRouter = HttpLayerRouter.use(router =>
  router.add("GET", "/api/health", HttpServerResponse.text("OK"))
)
