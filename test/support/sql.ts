import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer, String as Str } from "effect"
import { SqlClient } from "effect/sql"

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
)

// The node SQLite driver prepares a single statement at a time, so each
// migration file is split into top-level statements. The splitter ignores
// semicolons inside string literals and inside a trigger's `BEGIN ... END`
// body.
const splitStatements = (sql: string): ReadonlyArray<string> => {
  const statements: Array<string> = []
  let buffer = ""
  let inSingle = false
  let inDouble = false
  let depth = 0
  let begins = 0
  let ends = 0
  const isWordChar = (char: string) => /[A-Za-z_]/.test(char)
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    if (inSingle) {
      buffer += char
      if (char === "'") {
        if (sql[i + 1] === "'") buffer += sql[++i]
        else inSingle = false
      }
      continue
    }
    if (inDouble) {
      buffer += char
      if (char === '"') inDouble = false
      continue
    }
    if (char === "'") inSingle = true
    else if (char === '"') inDouble = true
    else if (char === "(") depth++
    else if (char === ")") depth--
    else if (isWordChar(char) && !isWordChar(sql[i - 1] ?? "")) {
      const match = /^(BEGIN|END)\b/i.exec(sql.slice(i))
      if (match) {
        if (match[1].toUpperCase() === "BEGIN") begins++
        else ends++
      }
    }
    if (char === ";" && depth === 0 && begins <= ends) {
      const statement = buffer.trim()
      if (statement) statements.push(statement)
      buffer = ""
      continue
    }
    buffer += char
  }
  const tail = buffer.trim()
  if (tail) statements.push(tail)
  return statements
}

const loadMigrations = () =>
  Object.fromEntries(
    readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => {
        const source = readFileSync(join(migrationsDirectory, file), "utf8").replace(/--[^\n]*/g, "")
        const statements = splitStatements(source)
        const migration = Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          for (const statement of statements) {
            yield* sql.unsafe(statement)
          }
        })
        return [file.replace(/\.sql$/, ""), migration]
      }),
  )

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
)
