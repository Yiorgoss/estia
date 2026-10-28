import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, Layer, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import { splitStatements } from "../../scripts/sql-split.mjs";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const loadMigrations = () =>
  Object.fromEntries(
    readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => {
        const source = readFileSync(join(migrationsDirectory, file), "utf8").replace(
          /--[^\n]*/g,
          "",
        );
        const statements = splitStatements(source);
        const migration = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const statement of statements) {
            yield* sql.unsafe(statement);
          }
        });
        return [file.replace(/\.sql$/, ""), migration];
      }),
  );

// An in-memory SQLite database with the project's migrations applied and the
// same name transforms the production D1 client uses (`src/app.ts`), so the
// repository SQL and row decoding behave exactly as in production.
export const TestSqlLive = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord(loadMigrations()),
}).pipe(
  Layer.provideMerge(
    SqliteClient.layer({
      filename: ":memory:",
      transformQueryNames: Str.camelToSnake,
      transformResultNames: Str.snakeToCamel,
    }),
  ),
);
