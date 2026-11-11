import { JWTSchema, RefreshTokenValue, UserId } from "@/db/schema/brands";
import { optionalCaller } from "@/handlers/optional-caller";
import { AuthMiddleware } from "@/middleware/auth-mw";
import { AuthService } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect";
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest } from "effect/http";

/*
 * Session resolution on its own, with the auth services stubbed so a test can
 * name the exact pair the resolver produced and see where it ends up. The
 * rotating session is what makes a private route reachable after the access
 * token ages out, so the pair it mints has to reach the client even when the
 * route itself never produces a response.
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

const AuthStub = (calls: Ref.Ref<number>) =>
  Layer.succeed(AuthService, {
    tokenAuthFlow: () =>
      Effect.flatMap(Ref.update(calls, (count) => count + 1), () =>
        Effect.succeed({ user: caller, tokens: rotated }),
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

const stubs = (calls: Ref.Ref<number>) =>
  Layer.mergeAll(AuthStub(calls), JwtStub, RefreshStub);

const request = (path: string, cookie?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`http://listings.test${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

describe("resolving a request's session", () => {
  it.effect("does not ask the auth flow about a visitor with no session cookies", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search")).pipe(
        Effect.provide(stubs(calls)),
      );

      assert.isTrue(Option.isNone(session.caller));
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );

  it.effect("returns the rotated pair for a request that presents a session", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const session = yield* optionalCaller(request("/search", "refresh_token=presented")).pipe(
        Effect.provide(stubs(calls)),
      );

      assert.deepStrictEqual(Option.getOrNull(session.caller), caller.id);
      assert.strictEqual(yield* Ref.get(calls), 1);
      assert.deepStrictEqual(
        session.cookies.map(([name, value]) => [name, value]),
        [
          ["access_token", rotated.accessToken],
          ["refresh_token", rotated.refreshToken],
        ],
      );
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
