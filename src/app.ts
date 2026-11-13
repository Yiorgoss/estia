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
import { StorageRepositoryLive } from "./repos/storage.repo";
import { PhotoThumbnailerLive } from "./services/photo-thumbnail.service";
import { ChatObjectLive } from "./repos/chat-object.repo";
import { handleChatSocketUpgrade, isChatSocketPath } from "./handlers/chat-socket";

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
  // One Durable Object per chat, addressed by the chat id as a name.
  readonly CHATS: DurableObjectNamespace;
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

/*
 * The application services, with every binding they need. The same layer serves
 * the HTTP router and the chat upgrade path: the upgrade is not an Effect route
 * (a 101 is not something the router represents), but it authenticates and checks
 * membership through the same services, so there is one session model and one
 * chat repository rather than a second copy for sockets.
 */
const makeServicesLayer = (bindings: WorkerBindings) =>
  AppServicesLive.pipe(
    Layer.provideMerge(
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
    // The chat object namespace is a binding too, so the service that posts
    // through it takes it from here.
    Layer.provideMerge(ChatObjectLive(bindings.CHATS)),
    Layer.provideMerge(ConfigProvider.layer(makeConfigProvider(bindings))),
    Layer.provide(bindings.ENVIRONMENT === "local" ? DevLoggerLive : ProdLoggerLive),
  );

let runtime: { readonly handler: (request: globalThis.Request) => Promise<Response> } | undefined;

const makeSocketRuntime = (bindings: WorkerBindings) =>
  ManagedRuntime.make(makeServicesLayer(bindings));

let socketRuntime: ReturnType<typeof makeSocketRuntime> | undefined;

const makeOrGetRuntime = (bindings: WorkerBindings) => {
  if (runtime != undefined) return runtime;
  runtime = HttpRouter.toWebHandler(
    WorkerApp.pipe(Layer.provideMerge(makeServicesLayer(bindings))),
  );
  return runtime;
};

const makeOrGetSocketRuntime = (bindings: WorkerBindings) => {
  const existing = socketRuntime;
  if (existing !== undefined) return existing;
  const created = makeSocketRuntime(bindings);
  socketRuntime = created;
  return created;
};

// The Durable Object class the `CHATS` binding names. A Worker can only reach a
// class it exports, so the object lives behind this re-export from the entry
// module.
export { Chat } from "./durable-objects/chat";

export default {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    void executionContext;
    /*
     * A WebSocket upgrade is handled before the Effect router. The router answers
     * with an ordinary response, and a 101 is a response the runtime builds around
     * a socket, so the upgrade is plumbed here and delegates its identity work to
     * `handleChatSocketUpgrade` and the app's own services.
     */
    if (isChatSocketPath(request)) {
      return handleChatSocketUpgrade({
        request,
        chats: env.CHATS,
        run: (effect) => makeOrGetSocketRuntime(env).runPromise(effect),
      });
    }
    return makeOrGetRuntime(env).handler(request);
  },
};
