import { D1Client } from "@effect/sql-d1";
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Path,
  References,
  String,
} from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import { HealthRouter } from "./api/health";
import { AppServicesLive, PrivateRouterLive, PublicRouterLive } from "./api";
import { StorageRepositoryLive } from "./repo/storage.repo";

export class EnvVars extends Context.Service<
  EnvVars,
  {
    readonly ENVIRONMENT: "local" | "production";
  }
>()("EnvVars", {
  make: Effect.gen(function* () {
    return {
      ENVIRONMENT: yield* Config.Literals(["local", "production"], "ENVIRONMENT").pipe(
        Config.withDefault("local" as const),
      ),
    };
  }),
}) {}

const EnvVarsLive = Layer.effect(EnvVars, EnvVars.make);

const CorsLayer = Effect.gen(function* () {
  const envVars = yield* EnvVars;
  const allowedOrigins =
    envVars.ENVIRONMENT == "production"
      ? ["https://domain.com"]
      : ["http://localhost:5173", "http://localhost:3000", "*"];

  return HttpRouter.cors({
    allowedOrigins,
    allowedMethods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Access-Control-Allow-Origin", "Content-Type", "Authorization", "traceparent"],
    credentials: true,
  });
}).pipe(Layer.unwrap, Layer.provide(EnvVarsLive));

const WorkerApp = Layer.mergeAll(
  HealthRouter,
  PublicRouterLive,
  PrivateRouterLive,
  // AppLive,
).pipe(
  Layer.provide(Etag.layer),
  Layer.provide(HttpPlatform.layer),
  Layer.provide(Path.layer),
  Layer.provide(FileSystem.layerNoop({})),
  Layer.provide(CorsLayer),
  Layer.provide(AppServicesLive),
  HttpRouter.provideRequest(AppServicesLive),
  //   Layer.provide(AppLive)
  // DisableTracerMW,
  // SpanNameMW
);

/*
  CLOUDFLARE WORKER
*/

type WorkerBindings = {
  readonly DB: D1Database;
  readonly STORAGE: R2Bucket;
  readonly ENVIRONMENT: "local" | "production";
} & {
  readonly [key: string]: string;
};

const makeConfigProvider = (bindings: Record<string, unknown>) => {
  const map: Record<string, string> = {};

  if (typeof globalThis.process != "undefined") {
    for (const [key, value] of Object.entries(globalThis.process.env)) {
      if (typeof value === "string") {
        map[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === "string") {
      map[key] = value;
    }
  }

  return ConfigProvider.fromUnknown(map);
};

// import * as util from 'util';
// console.log(util.inspect({ args }, { depth: null, colors: true }));
// const DevLogger = Logger.make((args) => {
//   // console.log({ args })
//   console.log(`[${args.logLevel.label}] ${args.message} ${args.annotations} `)
// })
const DevLoggerLive = Layer.merge(
  Logger.layer([
    Logger.consolePretty(),
    // DevLogger,
  ]),
  Layer.succeed(References.MinimumLogLevel, "Trace"),
);

const ProdLoggerLive = Layer.merge(
  Logger.layer([Logger.consoleJson]),
  Layer.succeed(References.MinimumLogLevel, "Debug"),
);

let runtime: { readonly handler: (request: globalThis.Request) => Promise<Response> } | undefined;

const makeOrGetRuntime = (bindings: WorkerBindings) => {
  if (runtime != undefined) return runtime;
  const configProviderLayer = ConfigProvider.layer(makeConfigProvider(bindings));

  return HttpRouter.toWebHandler(
    WorkerApp.pipe(
      Layer.provide(
        D1Client.layer({
          db: bindings.DB,
          transformQueryNames: String.camelToSnake,
          transformResultNames: String.snakeToCamel,
        }),
      ),
      HttpRouter.provideRequest(StorageRepositoryLive(bindings.STORAGE)),
      Layer.provide(configProviderLayer),
      Layer.provide(bindings.ENVIRONMENT === "local" ? DevLoggerLive : ProdLoggerLive),
    ),
  );
};

export default {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    void executionContext;
    return makeOrGetRuntime(env).handler(request);
  },
};
// from vid
// const DomainRpc = RpcGroup.make()

// class RpcLogger extends RpcMiddleware.Tag<RpcLogger>()("RpcLogger", {
//   wrap: true,
//   optional: true
// }) { }
// const RpcLoggerLive = Layer.succeed(
//   RpcLogger,
//   RpcLogger.of((opts) =>
//     Effect.tapErrorCause(opts.next, (cause) =>
//       Effect.annotateLogs(Effect.logError(`RPC request failed: ${opts.rpc._tag}`, cause), {
//         "rpc.method": opts.rpc._tag,
//         "rpc.clientId": opts.clientId
//       })
//     )
//   )
// )

// const RpcRouter = RpcServer.layerHttpRouter({
//   group: DomainRpc.middleware(RpcLogger),
//   path: "/rpc",
//   protocol: "http",
//   spanPrefix: "rpc"
// })

/* // src/worker.ts
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
} */
