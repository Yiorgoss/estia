import { HttpRouter, HttpServerResponse } from "effect/http";

/*
 * Liveness for the whole worker, not one route. This route needs no database and
 * no service, but the same service graph serves it. When a required config key
 * is missing the graph cannot build, so this route answers the 500 from
 * `src/app.ts` (naming the missing key in the response outside production and
 * logging it server-side). A 200 here means the graph built.
 */
export const HealthRouter = HttpRouter.use((router) =>
  router.add("GET", "/api/health", HttpServerResponse.text("OK")),
);
