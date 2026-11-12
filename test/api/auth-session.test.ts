import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { optionalCaller } from "@/handlers/optional-caller";
import { AuthMiddleware } from "@/middleware/auth-mw";
import { AuthService, UnauthorizedError } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/*
 * Session resolution on its own, with the auth services stubbed so a test can
 * name the exact pair the resolver produced and see where it ends up. The
 * rotating session is what makes a private route reachable after the access
 * token ages out, so the pair it mints has to reach the client even when the
 * route itself never produces a response, and a request that lost a rotation
 * race has to be told to retry rather than read as a visitor.
 */

const caller = {
  id: Schema.decodeUnknownSync(UserId)("session-test-user"),
  role: "seeker" as const,
};

const rotated = {
  accessToken: Schema.decodeUnknownSync(JWTSchema)("rotated-access"),
  refreshToken: Schema.decodeUnknownSync(RefreshTokenValue)("rotated-refresh"),
};

const unused = () => Effect.die("the test stub does not implement this path");

interface StubOptions {
  readonly fails?: boolean;
  readonly justRotated?: boolean;
}

const AuthStub = (calls: Ref.Ref<number>, fails: boolean) =>
  Layer.succeed(AuthService, {
    tokenAuthFlow: () =>
      Effect.flatMap(Ref.update(calls, (count) => count + 1), () =>
        fails
          ? Effect.fail(new UnauthorizedError())
          : Effect.succeed({ user: caller, tokens: rotated }),
      ),
    authenticate: unused,
    endAllSessions: unused,
  });

const JwtStub = Layer.succeed(JWTService, {
  asCookie: () => Effect.succeed(["access_token", rotated.accessToken]),
  clearCookie: unused,
  signUser: unused,
  verify: unused,
  extractUser: unused,
});

const RefreshStub = (justRotated: boolean) =>
  Layer.succeed(RefreshTokenService, {
    asCookie: () => Effect.succeed(["refresh_token", rotated.refreshToken]),
    justRotated: () => Effect.succeed(justRotated),
    clearCookie: unused,
    issueToken: unused,
    revokeToken: unused,
    userIdForToken: unused,
    revokeAllSessions: unused,
    consumeToken: unused,
    rotateToken: unused,
  });

const stubs = (calls: Ref.Ref<number>, options: StubOptions = {}) =>
  Layer.mergeAll(
    AuthStub(calls, options.fails ?? false),
    JwtStub,
    RefreshStub(options.justRotated ?? false),
  );

const request = (path: string, cookie?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`http://listings.test${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

const privateApp = (calls: Ref.Ref<number>, options: StubOptions) =>
  HttpRouter.toWebHandler(
    HttpRouter.add("GET", "/private-page", HttpServerResponse.text("page")).pipe(
      Layer.provide(AuthMiddleware),
      Layer.provide(stubs(calls, options)),
      Layer.provide(Etag.layer),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Path.layer),
      Layer.provide(FileSystem.layerNoop({})),
    ),
    { disableLogger: true },
  );

const send = (
  app: ReturnType<typeof privateApp>,
  headers: Readonly<Record<string, string>>,
) =>
  Effect.promise(() =>
    app.handler(new Request("http://listings.test/private-page", { headers })),
  );

describe("resolving a request's session", () => {
  it.effect("does not ask the auth flow about a visitor with no session cookies", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search")).pipe(
        Effect.provide(stubs(calls)),
      );

      assert.deepStrictEqual(session, { _tag: "anonymous" });
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );

  it.effect("returns the rotated pair for a request that presents a session", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search", "refresh_token=presented")).pipe(
        Effect.provide(stubs(calls)),
      );

      assert.strictEqual(session._tag, "caller");
      assert.strictEqual(yield* Ref.get(calls), 1);
      if (session._tag !== "caller") return;
      assert.strictEqual(session.caller, caller.id);
      assert.deepStrictEqual(
        session.cookies.map(([name, value]) => [name, value]),
        [
          ["access_token", rotated.accessToken],
          ["refresh_token", rotated.refreshToken],
        ],
      );
    }),
  );

  it.effect("asks a request that lost the rotation race to retry", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search", "refresh_token=presented")).pipe(
        Effect.provide(stubs(calls, { fails: true, justRotated: true })),
      );

      assert.deepStrictEqual(session, { _tag: "retry" });
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("reads a session whose rotation is over as anonymous", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search", "refresh_token=presented")).pipe(
        Effect.provide(stubs(calls, { fails: true, justRotated: false })),
      );

      assert.deepStrictEqual(session, { _tag: "anonymous" });
    }),
  );
});

describe("a private route that fails after the session rotated", () => {
  it.effect("answers with the runtime's 500 carrying the rotated pair", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const app = HttpRouter.toWebHandler(
        HttpRouter.add("GET", "/private-failure", Effect.die("boom")).pipe(
          Layer.provide(AuthMiddleware),
          Layer.provide(stubs(calls)),
          Layer.provide(Etag.layer),
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Path.layer),
          Layer.provide(FileSystem.layerNoop({})),
        ),
        { disableLogger: true },
      );

      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("http://listings.test/private-failure", {
            headers: { cookie: "refresh_token=presented", "user-agent": "estia-tests" },
          }),
        ),
      );

      assert.strictEqual(response.status, 500);
      const setCookies = response.headers
        .getSetCookie()
        .map((header) => header.split(";")[0] ?? "");
      assert.include(setCookies, `access_token=${rotated.accessToken}`);
      assert.include(setCookies, `refresh_token=${rotated.refreshToken}`);
    }),
  );
});

describe("a private route reached by a request that lost the rotation race", () => {
  it.effect("tells htmx to reload the page", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const response = yield* send(privateApp(calls, { fails: true, justRotated: true }), {
        cookie: "refresh_token=presented",
        "user-agent": "estia-tests",
        "hx-request": "true",
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("HX-Refresh"), "true");
      assert.strictEqual(yield* Effect.promise(() => response.text()), "");
    }),
  );

  it.effect("replays a navigation against the same page", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const response = yield* send(privateApp(calls, { fails: true, justRotated: true }), {
        cookie: "refresh_token=presented",
        "user-agent": "estia-tests",
      });

      assert.strictEqual(response.status, 307);
      assert.strictEqual(response.headers.get("location"), "/private-page");
    }),
  );
});
