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
import { StorageRepositoryLive } from "./repos/storage.repo";
import { PhotoThumbnailerLive } from "./services/photo-thumbnail.service";

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

const WorkerApp = Layer.mergeAll(HealthRouter, PublicRouterLive, PrivateRouterLive).pipe(
  Layer.provide(Etag.layer),
  Layer.provide(HttpPlatform.layer),
  Layer.provide(Path.layer),
  Layer.provide(FileSystem.layerNoop({})),
  Layer.provide(CorsLayer),
  Layer.provide(AppServicesLive),
  HttpRouter.provideRequest(AppServicesLive),
);

/*
  CLOUDFLARE WORKER
*/

type WorkerBindings = {
  readonly DB: D1Database;
  readonly STORAGE: R2Bucket;
  // The codec behind the downscaled card image of a gallery photo.
  readonly IMAGES: ImagesBinding;
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

  runtime = HttpRouter.toWebHandler(
    WorkerApp.pipe(
      Layer.provide(
        D1Client.layer({
          db: bindings.DB,
          transformQueryNames: String.camelToSnake,
          transformResultNames: String.snakeToCamel,
        }),
      ),
      // Object storage is a Worker binding, so it is built with the app and is
      // also visible to the services that capture it (the photo service), not
      // only to route effects that read it per request.
      Layer.provideMerge(StorageRepositoryLive(bindings.STORAGE)),
      Layer.provideMerge(PhotoThumbnailerLive(bindings.IMAGES)),
      Layer.provide(configProviderLayer),
      Layer.provide(bindings.ENVIRONMENT === "local" ? DevLoggerLive : ProdLoggerLive),
    ),
  );
  return runtime;
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
