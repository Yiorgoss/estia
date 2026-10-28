import { HttpRouter, HttpServerResponse } from "effect/http";

export const HealthRouter = HttpRouter.use((router) =>
  router.add("GET", "/api/health", HttpServerResponse.text("OK")),
);
