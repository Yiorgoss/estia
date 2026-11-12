import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { optionalCaller } from "@/handlers/optional-caller";
import { AuthMiddleware } from "@/middleware/auth-mw";
import { RefreshTokenNotFoundError } from "@/repos/refresh-token.repo";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenRotatedError, RefreshTokenService } from "@/services/refresh-token.service";
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
  // How the flow loses the presented refresh token, when it does.
  readonly failure?: "rotated" | "revoked";
}

type FlowFailure = RefreshTokenRotatedError | RefreshTokenNotFoundError;

const AuthStub = (calls: Ref.Ref<number>, failure: StubOptions["failure"]) =>
  Layer.succeed(AuthService, {
    tokenAuthFlow: (): Effect.Effect<
      { readonly user: typeof caller; readonly tokens: typeof rotated },
      FlowFailure
    > =>
      Effect.flatMap(
        Ref.update(calls, (count) => count + 1),
        (): Effect.Effect<
          { readonly user: typeof caller; readonly tokens: typeof rotated },
          FlowFailure
        > =>
          failure === undefined
            ? Effect.succeed({ user: caller, tokens: rotated })
            : Effect.fail<FlowFailure>(
                failure === "rotated"
                  ? new RefreshTokenRotatedError()
                  : new RefreshTokenNotFoundError(),
              ),
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

const RefreshStub = Layer.succeed(RefreshTokenService, {
  asCookie: () => Effect.succeed(["refresh_token", rotated.refreshToken]),
  clearCookie: unused,
  issueToken: unused,
  revokeToken: unused,
  userIdForToken: unused,
  revokeAllSessions: unused,
  consumeToken: unused,
  rotateToken: unused,
});

const stubs = (calls: Ref.Ref<number>, options: StubOptions = {}) =>
  Layer.mergeAll(AuthStub(calls, options.failure), JwtStub, RefreshStub);

const request = (path: string, cookie?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`http://listings.test${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

const privateApp = (calls: Ref.Ref<number>, options: StubOptions) =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add("GET", "/private-page", HttpServerResponse.text("page")),
      HttpRouter.add("POST", "/private-page", HttpServerResponse.text("posted")),
    ).pipe(
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
  method = "GET",
) =>
  Effect.promise(() =>
    app.handler(new Request("http://listings.test/private-page", { method, headers })),
  );

describe("resolving a request's session", () => {
  it.effect("does not ask the auth flow about a visitor with no session cookies", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search")).pipe(Effect.provide(stubs(calls)));

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
        Effect.provide(stubs(calls, { failure: "rotated" })),
      );

      assert.deepStrictEqual(session, { _tag: "retry" });
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("reads an unknown, revoked or expired token as anonymous", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search", "refresh_token=presented")).pipe(
        Effect.provide(stubs(calls, { failure: "revoked" })),
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
      const response = yield* send(privateApp(calls, { failure: "rotated" }), {
        cookie: "refresh_token=presented",
        "user-agent": "estia-tests",
        "hx-request": "true",
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("HX-Refresh"), "true");
      assert.strictEqual(yield* Effect.promise(() => response.text()), "");
    }),
  );

  it.effect("redirects a GET navigation back to the same page", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const response = yield* send(privateApp(calls, { failure: "rotated" }), {
        cookie: "refresh_token=presented",
        "user-agent": "estia-tests",
      });

      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.get("location"), "/private-page");
    }),
  );

  it.effect("sends a state-changing retry to a page that exists", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const response = yield* send(
        privateApp(calls, { failure: "rotated" }),
        {
          cookie: "refresh_token=presented",
          "user-agent": "estia-tests",
        },
        "POST",
      );

      assert.strictEqual(response.status, 303);
      assert.strictEqual(response.headers.get("location"), "/search");
    }),
  );

  it.effect("sends a spent token to sign-in instead of retrying again", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const response = yield* send(privateApp(calls, { failure: "revoked" }), {
        cookie: "refresh_token=presented",
        "user-agent": "estia-tests",
        "hx-request": "true",
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("HX-Redirect"), "/login");
      assert.isNull(response.headers.get("HX-Refresh"));
    }),
  );
});
