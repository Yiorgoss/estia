import { describeFailure } from "@/app";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { callWithMissingConfig } from "../support/api";

/*
 * A worker whose bindings lack a required key cannot build its service graph, so
 * every route fails, `/api/health` included. The failure used to reach the
 * operator as `Error: [object Object]`, because Effect's `ConfigError` is not an
 * `Error` instance and the Workers runtime can only format an `Error`. The
 * response must name the missing key instead.
 */

describe("a worker started without a required config key", () => {
  it.effect("names the missing JWT_SECRET instead of answering [object Object]", () =>
    Effect.gen(function* () {
      const response = yield* callWithMissingConfig(["JWT_SECRET"], "/api/health");

      assert.strictEqual(response.status, 500);
      assert.strictEqual(response.headers.get("content-type"), "application/json");
      assert.include(response.body, "JWT_SECRET");
      assert.notInclude(response.body, "[object Object]");
      assert.strictEqual(response.headers.get("cache-control"), "no-store");

      const payload = response.json as { readonly error?: string; readonly message?: string };
      assert.strictEqual(payload.error, "WorkerStartupError");
      assert.include(payload.message ?? "", "ConfigError");
      assert.include(payload.message ?? "", "SchemaError");
      assert.include(payload.message ?? "", "JWT_SECRET");
    }),
  );

  it.effect("names the missing DOMAIN when that key is the absent one", () =>
    Effect.gen(function* () {
      const response = yield* callWithMissingConfig(["DOMAIN"], "/api/health");

      assert.strictEqual(response.status, 500);
      assert.include(response.body, "DOMAIN");
      assert.notInclude(response.body, "[object Object]");
    }),
  );

  it.effect("still answers the app when every required key is present", () =>
    Effect.gen(function* () {
      const response = yield* callWithMissingConfig([], "/");

      assert.strictEqual(response.status, 200);
      assert.notInclude(response.body, "WorkerStartupError");
    }),
  );
});

describe("describeFailure", () => {
  it("renders a real Error with its name and message", () => {
    assert.strictEqual(describeFailure(new TypeError("boom")), "TypeError: boom");
  });

  it("renders a real Error together with its cause", () => {
    assert.strictEqual(
      describeFailure(new Error("outer", { cause: new Error("inner") })),
      "Error: outer, caused by Error: inner",
    );
  });

  it("uses a non-Error value's own toString, which is how ConfigError reads", () => {
    class FakeConfigError {
      readonly _tag = "ConfigError";
      readonly name = "ConfigError";
      get message(): string {
        return 'SchemaError(Expected string at ["JWT_SECRET"])';
      }
      toString(): string {
        return `ConfigError(${this.message})`;
      }
    }

    const described = describeFailure(new FakeConfigError());

    assert.include(described, "JWT_SECRET");
    assert.notInclude(described, "[object Object]");
  });

  it("falls back to the tagged fields of an object with no usable toString", () => {
    const described = describeFailure({
      _tag: "ConfigError",
      cause: { _tag: "SchemaError" },
    });

    assert.include(described, "ConfigError");
    assert.include(described, "SchemaError");
    assert.notInclude(described, "[object Object]");
  });

  it("never answers the string form of a bare object", () => {
    assert.strictEqual(describeFailure({}), "Unhandled worker failure");
  });
});
