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
run `pnpm seed` against the running dev server. See [docs/seed.md](docs/seed.md)
for the command and the seeded logins.

## Checks

```bash
pnpm run lint      # oxlint
pnpm run test:unit # vitest
pnpm run test:e2e  # migrations, real D1, dev server, and the HTTP smoke checklist
```
