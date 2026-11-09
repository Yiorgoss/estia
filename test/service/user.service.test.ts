import { ListerRepositoryLive } from "@/repos/lister.repo";
import { SeekerRepositoryLive } from "@/repos/seeker.repo";
import { UserRepositoryLive } from "@/repos/user.repo";
import { HasherServiceLive } from "@/services/hasher.service";
import { UserService, UserServiceLive } from "@/services/user.service";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestSqlLive } from "../support/sql";

const RepositoriesLive = Layer.mergeAll(
  UserRepositoryLive,
  ListerRepositoryLive,
  SeekerRepositoryLive,
).pipe(Layer.provide(TestSqlLive));

const TestLive = Layer.merge(
  UserServiceLive.pipe(Layer.provide(RepositoriesLive), Layer.provide(HasherServiceLive)),
  TestSqlLive,
);

const PASSWORD = "correct horse battery staple";

const count = (table: "users" | "seekers" | "listers") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`);
    return rows[0]?.total ?? -1;
  });

const counts = () =>
  Effect.gen(function* () {
    return {
      users: yield* count("users"),
      seekers: yield* count("seekers"),
      listers: yield* count("listers"),
    };
  });

const register = (email: string) =>
  Effect.gen(function* () {
    const service = yield* UserService;
    return yield* service.registerUser({ email, password: PASSWORD }, "estia-tests");
  });

/*
 * A real statement failure rather than a stubbed repository: the trigger makes
 * the insert into one profile table abort the way a missing table or a broken
 * constraint does, so everything before and after that write runs for real and
 * only the profile insert fails.
 */
const refuseInsertsInto = (table: "seekers" | "listers", trigger: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${table} insert refused'); END;`,
    );
  });

const allowInsertsInto = (trigger: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`DROP TRIGGER ${trigger}`);
  });

layer(TestLive, { concurrent: false })("UserService registration", (it) => {
  it.effect("creates the account with both profiles and no stored unassigned state", () =>
    Effect.gen(function* () {
      const before = yield* counts();

      const user = yield* register("register-both@test.local");

      assert.strictEqual(user.email, "register-both@test.local");
      assert.strictEqual(user.role, "seeker");
      assert.strictEqual(yield* count("users"), before.users + 1);
      assert.strictEqual(yield* count("seekers"), before.seekers + 1);
      assert.strictEqual(yield* count("listers"), before.listers + 1);
    }),
  );

  // The reported failure: the account row is written, the first profile insert
  // fails, and the caller is told the registration was refused. When the cleanup
  // succeeds nothing is left behind for a retry with the same address to collide
  // with, which is what the retry below shows.
  it.effect("leaves no account behind when the seeking profile cannot be opened", () =>
    Effect.gen(function* () {
      const email = "rollback-seeker@test.local";
      const before = yield* counts();
      yield* refuseInsertsInto("seekers", "refuse_seeker_insert");

      const failure = yield* Effect.flip(register(email));

      assert.strictEqual(failure._tag, "InternalError");
      assert.deepStrictEqual(yield* counts(), before);

      yield* allowInsertsInto("refuse_seeker_insert");
      const retried = yield* register(email);
      assert.strictEqual(retried.email, email);
      assert.strictEqual(yield* count("seekers"), before.seekers + 1);
      assert.strictEqual(yield* count("listers"), before.listers + 1);
    }),
  );

  // The same window on the second profile: the account and its seeking row are
  // already written when the listing insert fails, and both have to go.
  it.effect("leaves no account behind when the listing profile cannot be opened", () =>
    Effect.gen(function* () {
      const email = "rollback-lister@test.local";
      const before = yield* counts();
      yield* refuseInsertsInto("listers", "refuse_lister_insert");

      const failure = yield* Effect.flip(register(email));

      assert.strictEqual(failure._tag, "InternalError");
      assert.deepStrictEqual(yield* counts(), before);

      yield* allowInsertsInto("refuse_lister_insert");
      const retried = yield* register(email);
      assert.strictEqual(retried.email, email);
      assert.strictEqual(yield* count("seekers"), before.seekers + 1);
      assert.strictEqual(yield* count("listers"), before.listers + 1);
    }),
  );
});
