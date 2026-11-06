// Repository integration test for the listings domain.
//
// Drives the real ListingRepositoryLive module against a real D1 engine
// (Miniflare), applying the project's real SQL migrations (including
// 0004_listings.sql). It loads the TypeScript repository through Vite's SSR
// module loader so it exercises the same code the Worker runs, then asserts
// observable query/persistence behavior: create, find, search, the keyset
// cursor, the compare-and-set status transition, and that the database rejects
// rows the schema forbids.
//
// The Vite server and Miniflare instance are always torn down, and the process
// exits explicitly so a lingering workerd child cannot keep the test alive.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { Effect, Exit, Layer, Option, String as Str } from "effect";
import { SqlClient } from "effect/sql";
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

const ids = (page) => page.items.map((item) => item.id);

const rejects = async (label, promise) => {
  try {
    await promise;
  } catch (error) {
    check(label, true, String(error?.message ?? error).slice(0, 120));
    return;
  }
  check(label, false, "statement unexpectedly succeeded");
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

    const repoMod = await vite.ssrLoadModule("/src/repos/listing.repo.ts");
    const { D1Client } = await import("@effect/sql-d1");
    const { Miniflare } = await import(pathToFileURL(findMiniflare()).href);

    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: { DB: "listing-repo-integration" },
    });
    const db = await mf.getD1Database("DB");

    // The shared splitter in `scripts/sql-split.mjs` explains why each
    // migration is run one statement at a time through `prepare()`.
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

    console.log("listings repository integration against real D1");

    const regionCount = await db.prepare("SELECT COUNT(*) AS n FROM regions").first();
    check("regions table holds 13 rows", regionCount.n === 13, `got ${regionCount.n}`);

    const insert = (sql, ...args) =>
      db
        .prepare(sql)
        .bind(...args)
        .run();
    await insert(
      "INSERT INTO users (id,email,role,password_hash) VALUES (?,?,?,?)",
      "u-owner-1",
      "owner1@test.local",
      "user",
      "x",
    );
    await insert(
      "INSERT INTO users (id,email,role,password_hash) VALUES (?,?,?,?)",
      "u-owner-2",
      "owner2@test.local",
      "user",
      "x",
    );

    const SqlLive = D1Client.layer({
      db,
      transformQueryNames: Str.camelToSnake,
      transformResultNames: Str.snakeToCamel,
    });
    const RepoLive = repoMod.ListingRepositoryLive.pipe(Layer.provide(SqlLive));
    const run = (eff) => Effect.runPromise(Effect.provide(eff, RepoLive));
    const withRepo = (f) =>
      Effect.gen(function* () {
        const repo = yield* repoMod.ListingRepository;
        return yield* f(repo);
      });

    // Scenario A: create a listing through the repository.
    const created = await run(
      withRepo((repo) =>
        repo.create("u-owner-1", {
          kind: "room",
          title: "Sunny room in Athens",
          description: "Bright, near the metro",
          priceMinor: 45_000,
          regionCode: "attica",
          lat: 37.98,
          lng: 23.72,
          sizeSqm: 22,
          availableFrom: new Date(1_800_000_000_000),
          furnished: true,
          pets: true,
        }),
      ),
    );
    check(
      "create returns a draft with a real timestamp",
      created.status === "draft" &&
        created.currency === "EUR" &&
        created.ownerId === "u-owner-1" &&
        created.furnished === true &&
        created.availableFrom instanceof Date &&
        created.createdAt instanceof Date &&
        created.createdAt.getTime() > 1_600_000_000_000,
      JSON.stringify({ id: created.id, at: created.createdAt.toISOString() }),
    );

    const found = await run(withRepo((repo) => repo.findById(created.id)));
    check(
      "findById decodes the row",
      Option.isSome(found) && Option.getOrThrow(found).title === "Sunny room in Athens",
    );
    const missing = await run(withRepo((repo) => repo.findById(999_999)));
    check("findById(unknown) -> None", Option.isNone(missing));

    // Published fixtures share one millisecond so only `id DESC` can order them.
    const AT = 1_700_000_000_000;
    const seed = (id, status, extra = {}) =>
      insert(
        `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code,
                               lat, lng, furnished, created_at, updated_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        extra.kind ?? "room",
        extra.ownerId ?? "u-owner-1",
        status,
        `seed ${id}`,
        extra.priceMinor ?? 50_000,
        extra.regionCode ?? "attica",
        extra.lat ?? null,
        extra.lng ?? null,
        extra.furnished ?? 0,
        AT,
        AT,
        status === "published" ? AT : null,
      );
    await seed(5001, "published", { priceMinor: 40_000 });
    await seed(5002, "published", {
      kind: "whole_property",
      regionCode: "crete",
      priceMinor: 90_000,
    });
    await seed(5003, "published", { kind: "room_wanted", priceMinor: 65_000 });
    await seed(5004, "draft");

    const feed = await run(withRepo((repo) => repo.search({}, { limit: 50 })));
    check(
      "search sees published listings only",
      ids(feed).includes(5001) && ids(feed).includes(5002) && !ids(feed).includes(5004),
      JSON.stringify(ids(feed)),
    );
    check(
      "search filters kind",
      JSON.stringify(
        ids(await run(withRepo((repo) => repo.search({ kind: "whole_property" }, { limit: 50 })))),
      ) === "[5002]",
    );
    check(
      "search filters price range",
      JSON.stringify(
        ids(
          await run(withRepo((repo) => repo.search({ minPriceMinor: 45_000 }, { limit: 50 }))),
        ).sort(),
      ) === "[5002,5003]",
    );
    check(
      "search filters the four room bits including false",
      JSON.stringify(
        ids(
          await run(
            withRepo((repo) =>
              repo.search({ furnished: false, regionCode: "crete" }, { limit: 50 }),
            ),
          ),
        ),
      ) === "[5002]",
    );

    // Scenario B: keyset paging with identical timestamps.
    const page1 = await run(withRepo((repo) => repo.search({}, { limit: 2 })));
    check(
      "cursor page 1 is newest first",
      JSON.stringify(ids(page1)) === "[5003,5002]" && page1.nextCursor !== null,
      JSON.stringify(ids(page1)),
    );
    const page2 = await run(
      withRepo((repo) => repo.search({}, { limit: 2, cursor: page1.nextCursor })),
    );
    check(
      "cursor page 2 has no duplicates or holes",
      JSON.stringify(ids(page2)) === "[5001]",
      JSON.stringify(ids(page2)),
    );

    // Scenario C: the compare-and-set status transition.
    const published = await run(
      withRepo((repo) => repo.setStatus(created.id, "u-owner-1", ["draft"], "published")),
    );
    check(
      "setStatus draft -> published sets published_at",
      Option.isSome(published) &&
        Option.getOrThrow(published).status === "published" &&
        Option.getOrThrow(published).publishedAt instanceof Date,
    );
    const stale = await run(
      withRepo((repo) => repo.setStatus(created.id, "u-owner-1", ["draft"], "published")),
    );
    check("setStatus compare-and-set rejects a stale transition", Option.isNone(stale));
    const foreign = await run(
      withRepo((repo) => repo.setStatus(created.id, "u-owner-2", ["published"], "unpublished")),
    );
    check("setStatus is owner scoped", Option.isNone(foreign));
    const foreignUpdate = await run(
      withRepo((repo) => repo.update(created.id, "u-owner-2", { title: "Hijacked" })),
    );
    check("update is owner scoped inside the SQL", Option.isNone(foreignUpdate));

    // Scenario D: the database is the last line of defence.
    await insert(
      `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      5100,
      "room",
      "u-owner-1",
      "draft",
      "control row",
      1_000,
      "attica",
    );
    const control = await db.prepare("SELECT id FROM listings WHERE id = 5100").first();
    check("valid region insert works (control)", control?.id === 5100);
    await rejects(
      "D1 rejects an unknown region (FK)",
      insert(
        `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        5101,
        "room",
        "u-owner-1",
        "draft",
        "bad region",
        1_000,
        "atlantis",
      ),
    );
    await rejects(
      "D1 rejects an unknown kind (CHECK)",
      insert(
        `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        5102,
        "castle",
        "u-owner-1",
        "draft",
        "bad kind",
        1_000,
        "attica",
      ),
    );
    await rejects(
      "D1 rejects published without published_at (CHECK)",
      insert(
        `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        5103,
        "room",
        "u-owner-1",
        "published",
        "bad publish",
        1_000,
        "attica",
        null,
      ),
    );
    await rejects(
      "D1 rejects lat without lng (CHECK)",
      insert(
        `INSERT INTO listings (id, kind, owner_id, status, title, price_minor, region_code, lat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        5104,
        "room",
        "u-owner-1",
        "draft",
        "half pair",
        1_000,
        "attica",
        37.98,
      ),
    );

    // Scenario E: the D1 driver has no interactive transactions.
    const txExit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.gen(function* () {
            const sqlClient = yield* SqlClient.SqlClient;
            return yield* sqlClient.withTransaction(Effect.succeed("committed"));
          }),
          SqlLive,
        ),
      ),
    );
    check(
      "D1 withTransaction dies (unsupported)",
      Exit.isFailure(txExit),
      Exit.isFailure(txExit) ? String(txExit.cause).slice(0, 120) : "unexpected success",
    );
  } finally {
    if (mf) await mf.dispose().catch(() => {});
    if (vite) await vite.close().catch(() => {});
  }

  console.log(
    failures === 0
      ? "LISTING REPO INTEGRATION PASSED"
      : `LISTING REPO INTEGRATION FAILED (${failures})`,
  );
};

main().then(
  () => process.exit(failures === 0 ? 0 : 1),
  (e) => {
    console.error("harness error", e);
    process.exit(2);
  },
);
