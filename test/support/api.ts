import { AppServicesLive, PrivateRouterLive, PublicRouterLive } from "@/api";
import { StorageRepository } from "@/repos/storage.repo";
import { assert } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
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

// The multipart upload endpoint on the public router is the only consumer of R2;
// these tests never touch it, but the router's request services still name it.
const StorageRepositoryStub = Layer.succeed(StorageRepository, {
  put: () => Effect.die("storage is not used by the listing tests"),
  newMultipart: () => Effect.die("storage is not used by the listing tests"),
});

const ConfigLive = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ DOMAIN, JWT_SECRET, ENVIRONMENT: "local" }),
);

const AppLayer = Layer.mergeAll(PublicRouterLive, PrivateRouterLive).pipe(
  Layer.provide(Etag.layer),
  Layer.provide(HttpPlatform.layer),
  Layer.provide(Path.layer),
  Layer.provide(FileSystem.layerNoop({})),
  Layer.provide(AppServicesLive),
  Layer.provide(StorageRepositoryStub),
  HttpRouter.provideRequest(AppServicesLive),
  HttpRouter.provideRequest(StorageRepositoryStub),
  Layer.provide(TestSqlLive),
  Layer.provide(ConfigLive),
);

const app = HttpRouter.toWebHandler(AppLayer, { disableLogger: true });

export interface TestResponse {
  readonly status: number;
  readonly body: string;
  readonly json: unknown;
  readonly cookies: Readonly<Record<string, string>>;
  readonly location: string | null;
}

export const call = (path: string, init?: RequestInit): Effect.Effect<TestResponse> =>
  Effect.promise(async () => {
    const response = await app.handler(new Request(`http://localhost${path}`, init));
    const body = await response.text();
    const cookies: Record<string, string> = {};
    for (const header of response.headers.getSetCookie()) {
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
      location: response.headers.get("location"),
    };
  });

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
