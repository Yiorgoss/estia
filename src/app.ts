import { D1Client } from "@effect/sql-d1";
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Logger,
  ManagedRuntime,
  Path,
  References,
  String,
} from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import { HealthRouter } from "./api/health";
import { AppServicesLive, PrivateRouterLive, PublicRouterLive } from "./api";
import { handleChatSocketUpgrade, matchChatSocketPath } from "./handlers/private/chat-socket";
import { StorageRepositoryLive } from "./repos/storage.repo";
import { ChatGatewayLive } from "./services/chat-gateway.service";
import { PhotoThumbnailerLive } from "./services/photo-thumbnail.service";

export { Chat } from "./durable-objects/chat";

export class EnvVars extends Context.Service<
  EnvVars,
  {
    // `test` is the deployed test environment (`env.test` in `wrangler.jsonc`).
    // It is not production: the CORS list and the logger below treat it the way
    // they treat a local run, while the app still runs from the deployed
    // worker's bindings.
    readonly ENVIRONMENT: "local" | "test" | "production";
  }
>()("EnvVars", {
  make: Effect.gen(function* () {
    return {
      ENVIRONMENT: yield* Config.Literals(["local", "test", "production"], "ENVIRONMENT").pipe(
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
  // One Durable Object per chat: owns ordering, live sockets, fan-out, and rate limits.
  readonly CHATS: DurableObjectNamespace;
  readonly JWT_SECRET: string;
  readonly ENVIRONMENT: "local" | "test" | "production";
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
let socketRuntime:
  | ManagedRuntime.ManagedRuntime<Layer.Success<typeof AppServicesLive>, unknown>
  | undefined;

const makePlatformLayer = (bindings: WorkerBindings) => {
  const configProviderLayer = ConfigProvider.layer(makeConfigProvider(bindings));
  return Layer.mergeAll(
    D1Client.layer({
      db: bindings.DB,
      transformQueryNames: String.camelToSnake,
      transformResultNames: String.snakeToCamel,
    }),
    // Object storage, thumbnailer, and the Chat DO gateway are Worker bindings
    // captured alongside the app layer so both route handlers and services see them.
    StorageRepositoryLive(bindings.STORAGE),
    PhotoThumbnailerLive(bindings.IMAGES),
    ChatGatewayLive(bindings.CHATS),
  ).pipe(
    Layer.provideMerge(configProviderLayer),
    Layer.provideMerge(bindings.ENVIRONMENT === "local" ? DevLoggerLive : ProdLoggerLive),
  );
};

const makeOrGetRuntime = (bindings: WorkerBindings) => {
  if (runtime != undefined) return runtime;
  runtime = HttpRouter.toWebHandler(
    WorkerApp.pipe(Layer.provideMerge(makePlatformLayer(bindings))),
  );
  return runtime;
};

const makeOrGetSocketRuntime = (bindings: WorkerBindings) => {
  if (socketRuntime != undefined) return socketRuntime;
  socketRuntime = ManagedRuntime.make(
    AppServicesLive.pipe(Layer.provide(makePlatformLayer(bindings))),
  );
  return socketRuntime;
};

const isChatSocketRequest = (request: Request): boolean => {
  try {
    return matchChatSocketPath(new URL(request.url).pathname) !== null;
  } catch {
    return false;
  }
};

export default {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    void executionContext;
    if (isChatSocketRequest(request)) {
      return makeOrGetSocketRuntime(env).runPromise(
        handleChatSocketUpgrade(request, {
          CHATS: env.CHATS,
          JWT_SECRET: env.JWT_SECRET,
        }),
      );
    }
    return makeOrGetRuntime(env).handler(request);
  },
};
