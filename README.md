# estia

A rental listings app for Greece: rooms, whole properties, and room-wanted ads.
It runs as a Cloudflare Worker on D1, R2, Durable Objects, and the Images binding,
with server-rendered pages and a small progressive-enhancement frontend.

## Development

```bash
pnpm install
pnpm exec wrangler d1 migrations apply DB --local
pnpm dev
```

Then open http://localhost:5173.

To fill the local database with dummy accounts, profiles, listings, and photos,
run `pnpm seed` against the running dev server. `pnpm seed:test` seeds the
deployed test environment at https://estia.calisto.studio instead. The seed
script is `scripts/seed.ts`, written with Effect and run by Node's native
TypeScript support. See [docs/seed.md](docs/seed.md) for the commands and the
seeded logins.

## Test environment

The `test` environment deploys to `https://estia.calisto.studio`:

```bash
pnpm migrate:test   # apply D1 migrations to the test database
pnpm deploy:test    # build for env.test and deploy it
pnpm seed:test      # fill it with the seed data
```

## Checks

```bash
pnpm run lint      # oxlint
pnpm run test:unit # vitest
pnpm run test:e2e  # migrations, real D1, dev server, and the HTTP smoke checklist
```
