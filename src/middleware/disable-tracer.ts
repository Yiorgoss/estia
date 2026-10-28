import { Layer } from "effect";
import { HttpMiddleware } from "effect/http";

export const DisableTracerMW = Layer.succeed(HttpMiddleware.TracerDisabledWhen)((request) => {
  if (request.method === "OPTIONS") return true;
  const path = request.url.split("?")[0];

  return path === "/api/health" || path === "/rpc";
});
