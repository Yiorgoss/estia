// Repository integration test for the rooms domain.
//
// Drives the real RoomRepositoryLive module against a real D1 engine
// (Miniflare), applying the project's real SQL migrations. It loads the
// TypeScript repository through Vite's SSR module loader so it exercises the
// same code the Worker runs, then asserts observable query/persistence
// behavior.
//
// The Vite server and Miniflare instance are always torn down, and the process
// exits explicitly so a lingering workerd child cannot keep the test alive.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { Effect, Layer, Option, String as Str } from 'effect'
import { splitStatements } from './sql-split.mjs'

const root = process.cwd()

const findMiniflare = () => {
  const pnpmDir = path.join(root, 'node_modules/.pnpm')
  const entry = fs
    .readdirSync(pnpmDir)
    .filter((name) => name.startsWith('miniflare@'))
    .sort()
    .reverse()
    .map((name) => path.join(pnpmDir, name, 'node_modules/miniflare/dist/src/index.js'))
    .find((candidate) => fs.existsSync(candidate))
  if (!entry) throw new Error('miniflare package not found under node_modules/.pnpm')
  return entry
}

let failures = 0
const check = (label, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${label}${detail ? ` :: ${detail}` : ''}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const main = async () => {
  let vite
  let mf
  try {
    vite = await createServer({
      root,
      configFile: false,
      logLevel: 'error',
      server: { middlewareMode: true, hmr: false },
      resolve: { alias: { '@': path.resolve(root, 'src') } },
      appType: 'custom',
    })

    const repoMod = await vite.ssrLoadModule('/src/repo/room.repo.ts')
    const { D1Client } = await import('@effect/sql-d1')
    const { Miniflare } = await import(pathToFileURL(findMiniflare()).href)

    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: { DB: 'room-repo-integration' },
    })
    const db = await mf.getD1Database('DB')

    // The shared splitter in `scripts/sql-split.mjs` explains why each
    // migration is run one statement at a time through `prepare()`.
    const migDir = path.join(root, 'src/db/migrations')
    for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
      const raw = fs.readFileSync(path.join(migDir, f), 'utf8').replace(/--[^\n]*/g, '')
      for (const statement of splitStatements(raw)) {
        await db.prepare(statement).run()
      }
    }

    const insert = (sql, ...args) => db.prepare(sql).bind(...args).run()
    await insert(
      'INSERT INTO users (id,email,role,password_hash) VALUES (?,?,?,?)',
      'u-lister-1', 'lister1@test.local', 'lister', 'x',
    )
    await insert(
      'INSERT INTO users (id,email,role,password_hash) VALUES (?,?,?,?)',
      'u-lister-2', 'lister2@test.local', 'lister', 'x',
    )
    await insert(
      'INSERT INTO listers (id,user_id,name,ownership) VALUES (?,?,?,?)',
      1, 'u-lister-1', 'Lister One', 'owner',
    )
    await insert(
      'INSERT INTO listers (id,user_id,name,ownership) VALUES (?,?,?,?)',
      2, 'u-lister-2', 'Lister Two', 'leaseholder',
    )
    // three rooms for lister 1 (the regression: only the first used to be returned)
    await insert(
      'INSERT INTO rooms (id,lister_id,price,location,description,size,furnished,ensuite,smoking,pets,available_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      10, 1, 500, 'Athens', 'room a', 20, 1, 0, 0, 1, 946684800000,
    )
    await insert(
      'INSERT INTO rooms (id,lister_id,price,location,description,size,furnished,ensuite,smoking,pets,available_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      11, 1, 700, 'Patras', 'room b', 35, 0, 1, 1, 0, 978307200000,
    )
    await insert(
      'INSERT INTO rooms (id,lister_id,price,location,description,size,furnished,ensuite,smoking,pets,available_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      12, 1, 900, 'Athens', 'room c', 50, 1, 1, 1, 1, null,
    )
    // one room for lister 2
    await insert(
      'INSERT INTO rooms (id,lister_id,price,location,description,size,furnished,ensuite,smoking,pets,available_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      20, 2, 450, 'Thessaloniki', 'room d', 18, 0, 0, 0, 0, 946684800000,
    )

    const SqlLive = D1Client.layer({
      db,
      transformQueryNames: Str.camelToSnake,
      transformResultNames: Str.snakeToCamel,
    })
    const RepoLive = repoMod.RoomRepositoryLive.pipe(Layer.provide(SqlLive))
    const run = (eff) => Effect.runPromise(Effect.provide(eff, RepoLive))
    const withRepo = (f) =>
      Effect.gen(function*() {
        const repo = yield* repoMod.RoomRepository
        return yield* f(repo)
      })

    console.log('repository integration against real D1')

    // Scenario A: findAllByListerId returns every room for a lister
    const lister1 = await run(withRepo((r) => r.findAllByListerId(1)))
    check('findAllByListerId(1) returns all 3 rooms', lister1.length === 3, `got ${lister1.length}`)
    const lister2 = await run(withRepo((r) => r.findAllByListerId(2)))
    check('findAllByListerId(2) returns only its 1 room', lister2.length === 1, `got ${lister2.length}`)
    check(
      'rooms decode with boolean + date fields',
      typeof lister1[0].furnished === 'boolean' &&
        lister1[0].availableFrom instanceof Date &&
        lister1[0].id === 10,
      JSON.stringify({ furnished: lister1[0].furnished, availableFrom: lister1[0].availableFrom, id: lister1[0].id }),
    )

    // Scenario B: findWithFilters filters on value and bit flags
    const byPrice = await run(withRepo((r) => r.findWithFilters({ price: 500 })))
    check('findWithFilters({price:500}) -> 1 room', byPrice.length === 1 && byPrice[0].id === 10, `got ${byPrice.length}`)
    const byLocation = await run(withRepo((r) => r.findWithFilters({ location: 'Athens' })))
    check('findWithFilters({location:Athens}) -> 2 rooms (10,12)', byLocation.length === 2, `got ${byLocation.length}`)
    const byFurnished = await run(withRepo((r) => r.findWithFilters({ furnished: true })))
    check('findWithFilters({furnished:true}) -> 2 rooms (10,12)', byFurnished.length === 2, `got ${byFurnished.length}`)
    const byNotFurnished = await run(withRepo((r) => r.findWithFilters({ furnished: false })))
    check('findWithFilters({furnished:false}) filters to 0-bit rooms (11,20)', byNotFurnished.length === 2, `got ${byNotFurnished.length}`)
    const byPets = await run(withRepo((r) => r.findWithFilters({ pets: true })))
    check('findWithFilters({pets:true}) -> 2 rooms (10,12)', byPets.length === 2, `got ${byPets.length}`)
    const byNoPets = await run(withRepo((r) => r.findWithFilters({ pets: false })))
    check('findWithFilters({pets:false}) filters to 0-bit rooms (11,20)', byNoPets.length === 2, `got ${byNoPets.length}`)
    const byAvailable = await run(
      withRepo((r) => r.findWithFilters({ availableFrom: new Date(978307200000) })),
    )
    check(
      'findWithFilters({availableFrom}) -> room 11 (>= 2001-01-01)',
      byAvailable.length === 1 &&
        byAvailable[0].id === 11 &&
        byAvailable.every((x) => x.availableFrom.getTime() >= 978307200000),
      `got ${byAvailable.length}`,
    )
    const combined = await run(withRepo((r) => r.findWithFilters({ location: 'Athens', furnished: true })))
    check('findWithFilters combined -> rooms 10,12', combined.length === 2, `got ${combined.length}`)
    const empty = await run(withRepo((r) => r.findWithFilters({})))
    check('findWithFilters({}) -> all 4 rooms', empty.length === 4, `got ${empty.length}`)

    // Scenario C: nullish filter values must be ignored, not turned into `= NULL`
    const nullish = await run(
      withRepo((r) => r.findWithFilters({ size: null, availableFrom: null, price: null, location: null })),
    )
    check('findWithFilters(nullish values) -> all 4 rooms', nullish.length === 4, `got ${nullish.length}`)

    // Scenario D: findByRoomId returns None for missing id
    const none = await run(withRepo((r) => r.findByRoomId(99999)))
    check('findByRoomId(unknown) -> None', Option.isNone(none))

    // Scenario E: updateRoom produces valid SQL and persists changes
    const updated = await run(
      withRepo((r) =>
        r.updateRoom(11, {
          price: 777,
          location: 'Crete',
          description: 'updated desc',
          size: 42,
          furnished: false,
          ensuite: true,
          smoking: false,
          pets: true,
          availableFrom: new Date(1_600_000_000_000),
        }),
      ),
    )
    check('updateRoom returns Some', Option.isSome(updated), JSON.stringify(updated))
    const updatedRoom = Option.getOrThrow(updated)
    check(
      'updateRoom returned updated values',
      updatedRoom.price === 777 &&
        updatedRoom.location === 'Crete' &&
        updatedRoom.size === 42 &&
        updatedRoom.furnished === false &&
        updatedRoom.ensuite === true &&
        updatedRoom.smoking === false &&
        updatedRoom.pets === true &&
        updatedRoom.availableFrom instanceof Date &&
        updatedRoom.availableFrom.getTime() === 1_600_000_000_000,
      JSON.stringify(updatedRoom),
    )
    const reread = Option.getOrThrow(await run(withRepo((r) => r.findByRoomId(11))))
    check(
      'updateRoom persisted (re-read by id)',
      reread.price === 777 && reread.location === 'Crete' && reread.pets === true,
      JSON.stringify(reread),
    )
    const rawUpdate = await db
      .prepare('SELECT price,location,available_from,pets,ensuite FROM rooms WHERE id=11')
      .first()
    check(
      'updateRoom stored epoch millis + integer bits',
      rawUpdate.price === 777 &&
        rawUpdate.available_from === 1_600_000_000_000 &&
        rawUpdate.pets === 1 &&
        rawUpdate.ensuite === 1,
      JSON.stringify(rawUpdate),
    )
    const missing = await run(withRepo((r) => r.updateRoom(99999, {
      price: 1, location: 'X', description: null, size: null,
      furnished: false, ensuite: false, smoking: false, pets: false, availableFrom: null,
    })))
    check('updateRoom returns None for unknown id', Option.isNone(missing))

    // Scenario F: nullish update values persist as SQL NULL, not a crash or string
    const nulled = await run(withRepo((r) => r.updateRoom(12, {
      price: 300, location: 'Volos', description: null, size: null,
      furnished: false, ensuite: false, smoking: false, pets: false, availableFrom: null,
    })))
    const nulledRoom = Option.getOrThrow(nulled)
    check(
      'updateRoom stores NULL for nullish fields',
      nulledRoom.description === null && nulledRoom.size === null && nulledRoom.availableFrom === null &&
        nulledRoom.furnished === false && nulledRoom.pets === false,
      JSON.stringify(nulledRoom),
    )
  } finally {
    if (mf) await mf.dispose().catch(() => {})
    if (vite) await vite.close().catch(() => {})
  }

  console.log(failures === 0 ? 'ROOM REPO INTEGRATION PASSED' : `ROOM REPO INTEGRATION FAILED (${failures})`)
}

main().then(
  () => process.exit(failures === 0 ? 0 : 1),
  (e) => {
    console.error('harness error', e)
    process.exit(2)
  },
)
