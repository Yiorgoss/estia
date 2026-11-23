import {
  decodeRow,
  decodeRows,
  decodeSingle,
  query,
  R2DeleteError,
  R2ReadError,
  R2UploadError,
  RepositoryInvariantError,
  RowDecodeError,
  SqlQueryError,
  toInternalError,
} from "@/repos/errors";
import { UserRepository, UserRepositoryLive } from "@/repos/user.repo";
import { UserPasswordHash } from "@/db/schema/brands";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Logger, Schema } from "effect";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { TestSqlLive } from "../support/sql";

const SampleRow = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.DateFromMillis,
});

class DomainFailure extends Schema.TaggedError<DomainFailure>()("DomainFailure", {}) {}

const makeLogCollector = () => {
  const messages: Array<string> = [];
  const logger = Logger.make((options) => {
    messages.push(String(options.message));
  });
  return { messages, layer: Logger.layer([logger]) };
};

describe("src/repos/errors helpers", () => {
  it.effect("query wraps SqlError into SqlQueryError with operation and logs once", () =>
    Effect.gen(function* () {
      const logs = makeLogCollector();
      const sqlError = new SqlError({
        reason: new UnknownError({ cause: new Error("boom"), message: "boom" }),
      });

      const error = yield* Effect.flip(query("ExampleRepository.find", Effect.fail(sqlError))).pipe(
        Effect.provide(logs.layer),
      );

      assert.strictEqual(error._tag, "SqlQueryError");
      assert.strictEqual(error.operation, "ExampleRepository.find");
      assert.strictEqual(logs.messages.length, 1);
      assert.include(logs.messages[0] ?? "", "Repository query failed");
    }),
  );

  it.effect("decodeRow decodes valid rows and fails with RowDecodeError on drift", () =>
    Effect.gen(function* () {
      const ok = yield* decodeRow("ExampleRepository.find", SampleRow, {
        id: "r1",
        createdAt: 1000,
      });
      assert.strictEqual(ok.id, "r1");
      assert.strictEqual(ok.createdAt.getTime(), 1000);

      const logs = makeLogCollector();
      const failure = yield* Effect.flip(
        decodeRow("ExampleRepository.find", SampleRow, { id: 42, createdAt: "not-a-timestamp" }),
      ).pipe(Effect.provide(logs.layer));

      assert.strictEqual(failure._tag, "RowDecodeError");
      assert.strictEqual(failure.operation, "ExampleRepository.find");
      assert.strictEqual(logs.messages.length, 1);
      assert.include(logs.messages[0] ?? "", "Repository row decode failed");
    }),
  );

  it.effect("decodeRows decodes arrays and fails on the first invalid row", () =>
    Effect.gen(function* () {
      const ok = yield* decodeRows("ExampleRepository.list", SampleRow, [
        { id: "a", createdAt: 1 },
        { id: "b", createdAt: 2 },
      ]);
      assert.deepStrictEqual(
        ok.map((row) => row.id),
        ["a", "b"],
      );

      const failure = yield* Effect.flip(
        decodeRows("ExampleRepository.list", SampleRow, [
          { id: "a", createdAt: 1 },
          { id: null, createdAt: 2 },
        ]),
      );
      assert.strictEqual(failure._tag, "RowDecodeError");
      assert.strictEqual(failure.operation, "ExampleRepository.list");
    }),
  );

  it.effect("decodeSingle dies with RepositoryInvariantError when RETURNING yields no row", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeSingle("ExampleRepository.create", SampleRow, []));
      if (!Exit.isFailure(exit)) {
        assert.fail("expected decodeSingle to die with RepositoryInvariantError");
      }
      const defects = exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect);
      assert.strictEqual(defects.length, 1);
      assert.instanceOf(defects[0], RepositoryInvariantError);
      const invariant = defects[0] as RepositoryInvariantError;
      assert.strictEqual(invariant.operation, "ExampleRepository.create");
    }),
  );

  it.effect("toInternalError maps repository and storage errors while keeping domain errors", () =>
    Effect.gen(function* () {
      const logs = makeLogCollector();

      const fromSql = yield* Effect.flip(
        toInternalError(
          Effect.fail(new SqlQueryError({ operation: "Repo.op", cause: "sql failed" })),
        ),
      ).pipe(Effect.provide(logs.layer));
      assert.strictEqual(fromSql._tag, "InternalError");
      // SqlQueryError is already logged by `query`, so `toInternalError` does not log it again.
      assert.strictEqual(logs.messages.length, 0);

      const fromDecode = yield* Effect.flip(
        toInternalError(
          Effect.fail(new RowDecodeError({ operation: "Repo.op", cause: "bad row" })),
        ),
      ).pipe(Effect.provide(logs.layer));
      assert.strictEqual(fromDecode._tag, "InternalError");
      assert.strictEqual(logs.messages.length, 0);

      for (const storageError of [
        new R2UploadError({ cause: "upload" }),
        new R2ReadError({ cause: "read" }),
        new R2DeleteError({ cause: "delete" }),
      ]) {
        const mapped = yield* Effect.flip(toInternalError(Effect.fail(storageError))).pipe(
          Effect.provide(logs.layer),
        );
        assert.strictEqual(mapped._tag, "InternalError");
      }
      assert.strictEqual(logs.messages.length, 3);

      const kept = yield* Effect.flip(
        toInternalError(Effect.fail(new DomainFailure() as DomainFailure | SqlQueryError)),
      ).pipe(Effect.provide(logs.layer));
      assert.strictEqual(kept._tag, "DomainFailure");
    }),
  );

  it.effect("repository method failure emits a real method-scope error log", () =>
    Effect.gen(function* () {
      const logs = makeLogCollector();
      const TestLive = Layer.merge(UserRepositoryLive.pipe(Layer.provide(TestSqlLive)), logs.layer);

      const failure = yield* Effect.gen(function* () {
        const repo = yield* UserRepository;
        const hash = Schema.decodeSync(UserPasswordHash)("hash-log-test");
        yield* repo.insert({ email: "log-dup@test.local", password: hash, role: "user" });
        return yield* Effect.flip(
          repo.insert({ email: "log-dup@test.local", password: hash, role: "user" }),
        );
      }).pipe(Effect.provide(TestLive));

      assert.strictEqual(failure._tag, "SqlQueryError");
      assert.strictEqual(failure.operation, "UserRepository.insert");
      assert.strictEqual(logs.messages.length, 1);
      assert.include(logs.messages[0] ?? "", "Repository query failed");
    }),
  );
});
