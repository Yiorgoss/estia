
import { HttpMiddleware } from "@effect/platform"

export const DisableTracerMW = HttpMiddleware.withTracerDisabledWhen(request => {
  if (request.method === 'OPTIONS') return true
  const path = request.url.split("?")[0]

  return path === '/api/health' || path === '/rpc'
})
