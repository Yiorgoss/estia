import { AppServicesLive, PrivateRouterLive, PublicRouterLive } from "@/api";
import { StorageRepository } from "@/repos/storage.repo";
import { assert } from "@effect/vitest";
import { ConfigProvider, Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestSqlLive } from "./sql";

/*
 * A whole app behind a Fetch handler: the real public and private routers, the
 * real handlers, services, and repositories, over the in-memory D1-shaped
 * database from `./sql.ts`. The only thing faked is the network - a `Request`
 * goes in and a `Response` comes out - so a test sees exactly what a browser or
 * an API client sees.
 */

/*
 * workerd, where the app actually runs, implements `Uint8Array.prototype.toHex`,
 * which the refresh-token service uses to mint a token. Node 22, where these
 * tests run, does not, so registering a user would fail here for a reason that
 * exists only in the test runtime. Supplying the primitive keeps the tests on
 * the same code path the deployed runtime takes.
 */
const uint8ArrayPrototype = Uint8Array.prototype as unknown as { toHex?: () => string };
uint8ArrayPrototype.toHex ??= function (this: Uint8Array) {
  return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const DOMAIN = "http://listings.test";
const JWT_SECRET = "listings-test-secret-listings-test-secret";
const TEST_ORIGIN = "http://localhost";

/*
 * An in-memory R2, so an upload test can prove the bytes went somewhere and a
 * reader can fetch them back exactly as a browser would. Keys are the real
 * server-generated keys; the test never supplies one.
 */
const storedObjects = new Map<string, Uint8Array>();
const encoder = new TextEncoder();

const bytesOf = async (
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
): Promise<Uint8Array> => {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
};

const fakeObject = (key: string, bytes: Uint8Array): R2Object =>
  ({
    key,
    size: bytes.length,
    etag: `etag-${key}`,
    httpEtag: `"etag-${key}"`,
    uploaded: new Date(0),
    storageClass: "Standard",
    version: "v1",
    checksums: {},
    customMetadata: {},
    range: undefined,
  }) as unknown as R2Object;

const fakeBody = (key: string, bytes: Uint8Array): R2ObjectBody =>
  ({
    ...fakeObject(key, bytes),
    body: new Response(bytes).body ?? new ReadableStream(),
    bodyUsed: false,
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    blob: async () => new Blob([bytes]),
    range: undefined,
  }) as unknown as R2ObjectBody;

const StorageRepositoryStub = Layer.succeed(StorageRepository, {
  put: (key, value) =>
    Effect.promise(async () => {
      const bytes = await bytesOf(value);
      storedObjects.set(key, bytes);
      return fakeObject(key, bytes);
    }),
  get: (key) =>
    Effect.sync(() => {
      const bytes = storedObjects.get(key);
      return Option.fromNullishOr(bytes === undefined ? undefined : fakeBody(key, bytes));
    }),
  delete: (key) =>
    Effect.sync(() => {
      storedObjects.delete(key);
    }),
});

// Tests that have to prove what storage holds can ask by exact key; production
// code never can.
export const storageEntries = () => Array.from(storedObjects.keys());

const makeApp = (config: Readonly<Record<string, string>> = {}) => {
  const ConfigLive = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ DOMAIN, JWT_SECRET, ENVIRONMENT: "local", ...config }),
  );

  const AppLayer = Layer.mergeAll(PublicRouterLive, PrivateRouterLive).pipe(
    Layer.provide(Etag.layer),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Path.layer),
    Layer.provide(FileSystem.layerNoop({})),
    Layer.provide(AppServicesLive),
    HttpRouter.provideRequest(AppServicesLive),
    Layer.provideMerge(StorageRepositoryStub),
    Layer.provide(TestSqlLive),
    Layer.provide(ConfigLive),
  );

  // Sharing the memo map is what lets `query` below reach the one database this
  // app instance runs on instead of opening a second, empty one.
  const memoMap = Layer.makeMemoMapUnsafe();
  return { memoMap, web: HttpRouter.toWebHandler(AppLayer, { disableLogger: true, memoMap }) };
};

/*
 * The handler shape this harness calls: one request in, one response out. The
 * router's own type is conditional on whether a layer graph leaves a
 * requirement, and reading it back out of the app object does not resolve that
 * condition, so the harness names the shape it uses.
 */
type TestApp = {
  readonly handler: (request: globalThis.Request) => Promise<globalThis.Response>;
};

const shared = makeApp();
const app: TestApp = shared.web;

/*
 * The database behind the shared app, for a test that has to prove what an
 * endpoint did to a row rather than infer it from a later response: the same
 * `SqlClient` the handlers use, so both see one in-memory D1-shaped database.
 */
export const query = <T extends object = Record<string, unknown>>(
  statement: string,
  params: ReadonlyArray<unknown> = [],
): Effect.Effect<ReadonlyArray<T>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const context = yield* Layer.buildWithMemoMap(TestSqlLive, shared.memoMap, scope);
      const sql = Context.get(context, SqlClient.SqlClient);
      return yield* sql.unsafe<T>(statement, params);
    }),
  ).pipe(Effect.orDie);

export interface TestResponse {
  readonly status: number;
  readonly body: string;
  readonly json: unknown;
  readonly cookies: Readonly<Record<string, string>>;
  // The `Set-Cookie` headers verbatim, so a test can pin the attributes a
  // browser applies to a cookie, not just its value.
  readonly setCookies: ReadonlyArray<string>;
  readonly location: string | null;
}

const callThrough = (
  testApp: TestApp,
  path: string,
  init?: RequestInit,
): Effect.Effect<TestResponse> =>
  Effect.promise(async () => {
    const response = await testApp.handler(new Request(`${TEST_ORIGIN}${path}`, init));
    const body = await response.text();
    const cookies: Record<string, string> = {};
    const setCookies = response.headers.getSetCookie();
    for (const header of setCookies) {
      const [pair = ""] = header.split(";");
      const index = pair.indexOf("=");
      cookies[pair.slice(0, index)] = pair.slice(index + 1);
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    return {
      status: response.status,
      body,
      json,
      cookies,
      setCookies,
      location: response.headers.get("location"),
    };
  });

export const call = (path: string, init?: RequestInit): Effect.Effect<TestResponse> =>
  callThrough(app, path, init);

// A separate app instance, so a test can drive a configuration the shared one
// does not use.
export const callWithConfig = (
  config: Readonly<Record<string, string>>,
  path: string,
  init?: RequestInit,
): Effect.Effect<TestResponse> => callThrough(makeApp(config).web, path, init);

export const testOrigin = TEST_ORIGIN;

export interface TestUser {
  readonly id: string;
  readonly cookie: string;
}

// A browser always sends a user agent, and the refresh-token record stores it,
// so the requests here carry one too.
export const json = (init: RequestInit, payload?: unknown): RequestInit => ({
  ...init,
  headers: { "content-type": "application/json", "user-agent": "estia-tests", ...init.headers },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});

/*
 * What a browser sends when it submits one of the server-rendered forms: the
 * declared form content type, with the fields URL-encoded in the body.
 */
export const form = (init: RequestInit, fields: Readonly<Record<string, string>>): RequestInit => ({
  ...init,
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "estia-tests",
    ...init.headers,
  },
  body: new URLSearchParams(fields).toString(),
});

export interface UploadFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/*
 * What a browser sends when it submits the gallery's upload form: one multipart
 * body with a repeated `photos` field. The boundary is generated by `FormData`,
 * so the request exercises the same parser a real upload does.
 */
export const multipart = (init: RequestInit, files: ReadonlyArray<UploadFile>): RequestInit => {
  const formData = new FormData();
  for (const file of files) {
    formData.append("photos", new Blob([file.bytes], { type: file.contentType }), file.name);
  }
  return {
    ...init,
    headers: { "user-agent": "estia-tests", ...init.headers },
    body: formData,
  };
};

export const send = (
  method: string,
  path: string,
  options: { readonly cookie?: string; readonly payload?: unknown } = {},
) =>
  call(
    path,
    json(
      {
        method,
        ...(options.cookie === undefined ? {} : { headers: { cookie: options.cookie } }),
      },
      options.payload,
    ),
  );

export const register = (label: string): Effect.Effect<TestUser> =>
  Effect.gen(function* () {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const response = yield* send("POST", "/api/auth/register", {
      payload: { email, password: "correct horse battery staple" },
    });
    assert.strictEqual(response.status, 200, `register ${label}: ${response.body}`);
    const accessToken = response.cookies["access_token"];
    assert.isString(accessToken);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
    return { id: String(claims.id), cookie: `access_token=${accessToken}` };
  });

export const asObject = (value: unknown): Record<string, unknown> => {
  assert.isObject(value);
  return value as Record<string, unknown>;
};
