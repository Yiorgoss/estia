import { D1Client } from "@effect/sql-d1";
import {
  Cause,
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

/*
 * The `ENVIRONMENT` values the app accepts. Every environment in
 * `wrangler.jsonc` must name one of these: an invalid literal is a build
 * failure of the whole service graph, not a warning, and
 * `test/config/wrangler-config.test.ts` holds the configuration to this list.
 *
 * `test` is the deployed test environment (`env.test` in `wrangler.jsonc`). It
 * is not production: the CORS list and the 500 diagnostics below treat it like
 * a local run, while the logger uses `ProdLoggerLive` and the app runs from the
 * deployed worker's bindings.
 */
export const ENVIRONMENTS = ["local", "test", "production"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export class EnvVars extends Context.Service<
  EnvVars,
  {
    readonly ENVIRONMENT: Environment;
  }
>()("EnvVars", {
  make: Effect.gen(function* () {
    return {
      ENVIRONMENT: yield* Config.Literals(ENVIRONMENTS, "ENVIRONMENT").pipe(
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
  readonly ENVIRONMENT: Environment;
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
  // `toWebHandler` starts the graph build immediately. If that build fails, the
  // handler stays cached and every request rejects with the same error, which
  // `respondWithDiagnostics` turns into a readable 500 and a log line.
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

/*
  DIAGNOSABLE STARTUP FAILURES

  `HttpRouter.toWebHandler` builds the whole service graph and, if the build
  fails, rejects every request with the build error (see the `toWebHandlerLayer`
  docs). The common cause is a missing Worker variable: `JWTServiceLive` reads
  `DOMAIN` and `JWT_SECRET`, so a worker that has neither cannot answer any
  route, not even `/api/health`.

  That build error is an Effect `ConfigError`, which is not an `Error` instance.
  The Workers runtime formats a rejected `Error` with its message but has only
  `Object.prototype.toString` for anything else, so an unguarded rejection
  surfaces as `Error: [object Object]` and the operator cannot see which key is
  missing. The functions below keep the readable cause: they always log it and
  answer a 500 whose body names it outside production and stays generic in
  production. `/api/health` answers that 500 too, because the graph that serves
  it is the same graph that failed to build.
*/

const MAX_FAILURE_DETAIL_LENGTH = 2_000;
const MAX_FAILURE_DEPTH = 4;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const stringField = (value: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
};

// Effect's `ConfigError` and `SchemaError` carry a `toString` that renders the
// readable cause. A plain object inherits `Object.prototype.toString`, which
// renders `[object Object]` and is exactly what must not reach the operator.
const customToString = (value: Readonly<Record<string, unknown>>): string | undefined => {
  try {
    const candidate = value["toString"];
    if (typeof candidate !== "function" || candidate === Object.prototype.toString) {
      return undefined;
    }
    const text = `${value}`;
    return text === "" || text === "[object Object]" ? undefined : text;
  } catch {
    return undefined;
  }
};

/*
 * A readable description of a rejected value. It prefers, in order: a string, an
 * Effect `Cause`, a real `Error`, the value's own `toString`, and finally the
 * tagged-error fields (`_tag`, `name`, `message`, `cause`). Every path returns
 * text; none returns `[object Object]`.
 */
export const describeFailure = (failure: unknown, depth = 0): string => {
  if (typeof failure === "string") return failure;
  if (failure === undefined) return "undefined";
  if (failure === null) return "null";
  if (Cause.isCause(failure)) return Cause.pretty(failure);
  if (failure instanceof Error) {
    const message = `${failure.name}: ${failure.message}`;
    const cause: unknown = failure.cause;
    return cause === undefined || depth >= MAX_FAILURE_DEPTH
      ? message
      : `${message}, caused by ${describeFailure(cause, depth + 1)}`;
  }
  if (isRecord(failure)) {
    const custom = customToString(failure);
    if (custom !== undefined) return custom;
    const label =
      stringField(failure, "name") ?? stringField(failure, "_tag") ?? "Unhandled worker failure";
    const message = stringField(failure, "message");
    const head = message === undefined ? label : `${label}: ${message}`;
    const cause = failure["cause"];
    return cause === undefined || depth >= MAX_FAILURE_DEPTH
      ? head
      : `${head}, caused by ${describeFailure(cause, depth + 1)}`;
  }
  try {
    return `${failure}`;
  } catch {
    return "Unhandled worker failure";
  }
};

const truncate = (text: string): string =>
  text.length <= MAX_FAILURE_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_FAILURE_DETAIL_LENGTH)}...`;

const logFailure = (request: Request, detail: string): void => {
  try {
    // Logging must never replace the diagnostic with a second failure.
    Effect.runSync(
      Effect.logError(`[worker] ${request.method} ${request.url} rejected: ${detail}`),
    );
  } catch {
    // Never let a logging failure prevent the 500 response below.
  }
};

const failureResponse = (request: Request, failure: unknown, environment?: string): Response => {
  const detail = describeFailure(failure);
  logFailure(request, detail);
  const includeDetail = environment !== "production";
  return Response.json(
    {
      error: "InternalServerError",
      message: includeDetail ? truncate(detail) : "Internal Server Error",
    },
    {
      status: 500,
      headers: { "cache-control": "no-store" },
    },
  );
};

/*
 * Runs one request against the worker. Any uncaught rejection is logged in
 * readable form instead of reaching the runtime as `[object Object]`, and
 * answered as a 500 JSON response with failure details included only outside
 * production.
 */
export const respondWithDiagnostics = async (
  request: Request,
  respond: () => Promise<Response>,
  environment?: string,
): Promise<Response> => {
  try {
    return await respond();
  } catch (failure) {
    return failureResponse(request, failure, environment);
  }
};

export default {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    void executionContext;
    const respond = (): Promise<Response> =>
      isChatSocketRequest(request)
        ? makeOrGetSocketRuntime(env).runPromise(
            handleChatSocketUpgrade(request, {
              CHATS: env.CHATS,
              JWT_SECRET: env.JWT_SECRET,
            }),
          )
        : makeOrGetRuntime(env).handler(request);
    return respondWithDiagnostics(request, respond, env.ENVIRONMENT);
  },
};
