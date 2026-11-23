// Repository integration test for the users domain.
//
// Drives the real UserRepositoryLive module against a real D1 engine
// (Miniflare), applying the project's real SQL migrations. It loads the
// TypeScript repository through Vite's SSR module loader so it exercises the
// same code the Worker runs, then asserts real D1 behavior: insert, lookup by
// email/id, role update, duplicate email failure as `SqlQueryError`, and
// cascading delete.
//
// The Vite server and Miniflare instance are always torn down, and the process
// exits explicitly so a lingering workerd child cannot keep the test alive.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { Effect, Layer, Option, String as Str } from "effect";
import { splitStatements } from "./sql-split.mjs";

const root = process.cwd();

const findMiniflare = () => {
  const pnpmDir = path.join(root, "node_modules/.pnpm");
  const entry = fs
    .readdirSync(pnpmDir)
    .filter((name) => name.startsWith("miniflare@"))
    .sort()
    .reverse()
    .map((name) => path.join(pnpmDir, name, "node_modules/miniflare/dist/src/index.js"))
    .find((candidate) => fs.existsSync(candidate));
  if (!entry) throw new Error("miniflare package not found under node_modules/.pnpm");
  return entry;
};

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) {
    console.log(`  ok   ${label}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
  }
};

const main = async () => {
  let vite;
  let mf;
  try {
    vite = await createServer({
      root,
      configFile: false,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false },
      resolve: { alias: { "@": path.resolve(root, "src") } },
      appType: "custom",
    });

    const repoMod = await vite.ssrLoadModule("/src/repos/user.repo.ts");
    const { D1Client } = await import("@effect/sql-d1");
    const { Miniflare } = await import(pathToFileURL(findMiniflare()).href);

    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: { DB: "user-repo-integration" },
    });
    const db = await mf.getD1Database("DB");

    const migDir = path.join(root, "src/db/migrations");
    const migrationFiles = fs
      .readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of migrationFiles) {
      const raw = fs.readFileSync(path.join(migDir, f), "utf8").replace(/--[^\n]*/g, "");
      for (const statement of splitStatements(raw)) {
        await db.prepare(statement).run();
      }
    }

    console.log("user repository integration against real D1");

    const SqlLive = D1Client.layer({
      db,
      transformQueryNames: Str.camelToSnake,
      transformResultNames: Str.snakeToCamel,
    });
    const RepoLive = repoMod.UserRepositoryLive.pipe(Layer.provide(SqlLive));
    const run = (eff) => Effect.runPromise(Effect.provide(eff, RepoLive));
    const withRepo = (f) =>
      Effect.gen(function* () {
        const repo = yield* repoMod.UserRepository;
        return yield* f(repo);
      });

    // Dead and broken `updateAvatar` must stay removed.
    const hasUpdateAvatar = await run(withRepo((repo) => Effect.succeed("updateAvatar" in repo)));
    check("UserRepository does not expose removed updateAvatar", !hasUpdateAvatar);

    // Scenario A: insert and decode through real D1.
    const insertedOption = await run(
      withRepo((repo) =>
        repo.insert({
          email: "alice@test.local",
          password: "hash-alice",
          role: "seeker",
        }),
      ),
    );
    check("insert returns Some(user)", Option.isSome(insertedOption));
    const inserted = Option.getOrThrow(insertedOption);
    check(
      "insert decodes fields and Date timestamps",
      inserted.email === "alice@test.local" &&
        inserted.passwordHash === "hash-alice" &&
        inserted.role === "seeker" &&
        inserted.id.length > 0 &&
        inserted.createdAt instanceof Date &&
        inserted.updatedAt instanceof Date &&
        !Number.isNaN(inserted.createdAt.getTime()),
      JSON.stringify({ id: inserted.id, role: inserted.role }),
    );

    // Scenario B: findByEmail and findById.
    const byEmail = await run(withRepo((repo) => repo.findByEmail("alice@test.local")));
    check(
      "findByEmail finds inserted user",
      Option.isSome(byEmail) && Option.getOrThrow(byEmail).id === inserted.id,
    );
    const missingEmail = await run(withRepo((repo) => repo.findByEmail("nobody@test.local")));
    check("findByEmail(unknown) -> None", Option.isNone(missingEmail));

    const byId = await run(withRepo((repo) => repo.findById(inserted.id)));
    check(
      "findById finds inserted user",
      Option.isSome(byId) && Option.getOrThrow(byId).email === "alice@test.local",
    );
    const missingId = await run(withRepo((repo) => repo.findById("nonexistent-id")));
    check("findById(unknown) -> None", Option.isNone(missingId));

    // Scenario C: updateRole.
    const updated = await run(withRepo((repo) => repo.updateRole(inserted.id, "lister")));
    check(
      "updateRole updates role and returns decoded row",
      Option.isSome(updated) &&
        Option.getOrThrow(updated).role === "lister" &&
        Option.getOrThrow(updated).updatedAt instanceof Date,
    );
    const missingUpdate = await run(withRepo((repo) => repo.updateRole("nonexistent-id", "admin")));
    check("updateRole(unknown) -> None", Option.isNone(missingUpdate));

    // Scenario D: duplicate email fails with SqlQueryError (not raw SqlError).
    const duplicateError = await run(
      Effect.flip(
        withRepo((repo) =>
          repo.insert({
            email: "alice@test.local",
            password: "hash-duplicate",
            role: "seeker",
          }),
        ),
      ),
    );
    check(
      "duplicate email fails with SqlQueryError carrying operation name",
      duplicateError._tag === "SqlQueryError" &&
        duplicateError.operation === "UserRepository.insert",
      JSON.stringify({ tag: duplicateError._tag, op: duplicateError.operation }),
    );

    // Scenario E: deleteById removes user and cascades dependent rows.
    await db
      .prepare("INSERT INTO seekers (user_id, name) VALUES (?, ?)")
      .bind(inserted.id, "Alice")
      .run();
    await run(withRepo((repo) => repo.deleteById(inserted.id)));
    const afterDelete = await run(withRepo((repo) => repo.findById(inserted.id)));
    check("deleteById removes the user row", Option.isNone(afterDelete));
    const remainingSeekers = await db
      .prepare("SELECT COUNT(*) AS n FROM seekers WHERE user_id = ?")
      .bind(inserted.id)
      .first();
    check(
      "deleteById cascades to dependent tables",
      remainingSeekers?.n === 0,
      `remaining seekers=${remainingSeekers?.n}`,
    );
  } finally {
    if (mf) await mf.dispose().catch(() => {});
    if (vite) await vite.close().catch(() => {});
  }

  console.log(
    failures === 0 ? "USER REPO INTEGRATION PASSED" : `USER REPO INTEGRATION FAILED (${failures})`,
  );
};

main().then(
  () => process.exit(failures === 0 ? 0 : 1),
  (e) => {
    console.error("harness error", e);
    process.exit(2);
  },
);
