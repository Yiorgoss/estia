// src/worker.ts
import { Effect, Layer, ManagedRuntime, ConfigProvider } from "effect"
import { CloudflareBindings } from "./services/cf-bindings"
import { AppLive } from "./app"

// Type for Cloudflare Worker Env
interface Env {
  DB: D1Database
  MY_KV: KVNamespace
  MY_BUCKET: R2Bucket
  API_KEY: string
  // ... other bindings
}

// Create runtime factory
const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}

// Main fetch handler
const handleFetch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Effect.Effect<Response, never, AppDependencies> =>
  Effect.gen(function*() {
    const url = new URL(request.url)

    // Route handling (basic example)
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 })
    }

    if (url.pathname.startsWith("/api/")) {
      return yield* handleApiRequest(request)
    }

    return new Response("Not Found", { status: 404 })
  }).pipe(
    // Error handling
    Effect.catchAll((error) =>
      Effect.succeed(
        new Response(JSON.stringify({ error: String(error) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      )
    )
  )

// Export for Cloudflare
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runtime = makeRuntime(env, ctx)

    const program = handleFetch(request, env, ctx).pipe(
      Effect.withConfigProvider(ConfigProvider.fromJson(env))
    )

    try {
      return await runtime.runPromise(program)
    } finally {
      // Cleanup runtime resources
      await runtime.dispose()
    }
  },
}
