# Seed data for local development

`pnpm seed` fills a running local dev server with dummy people and listings so the
feed, the map, the listing detail pages, the galleries, and the profile pages have
something real to show.

```bash
# 1. Apply the local database migrations once.
pnpm exec wrangler d1 migrations apply DB --local

# 2. Start the dev server (any port works).
pnpm dev --port 5173

# 3. In another terminal, seed it.
pnpm seed
```

The script talks to the server at `http://127.0.0.1:5173` by default. Point it at
another local port with `SEED_BASE_URL=http://127.0.0.1:8801 pnpm seed`.

## Logins

Every seeded account uses the password `test`. The table below is the same one
the script prints when it finishes.

```
EMAIL               PASSWORD  ROLE
------------------  --------  ------
lister1@test.local  test      lister
lister2@test.local  test      lister
seeker1@test.local  test      seeker
seeker2@test.local  test      seeker
both@test.local     test      both
```

`both@test.local` holds a filled seeking profile and a filled listing profile, and
owns listings. The stored role of that account is `lister`, so it can sign in and
manage listings; the seeking profile stays saved for the role switch.

## What it seeds

- Five accounts: two listers, two seekers, and one account that both seeks and
  lists.
- Filled profiles: a name, date of birth, gender, and bio for seekers; a display
  name and ownership for listers.
- Eight published listings across Attica, Crete, Central Macedonia, and Western
  Greece, covering the `room`, `whole_property`, and `room_wanted` kinds, prices
  from 350 to 1150 euros, and both furnished and unfurnished places.
- 28 photos, fetched from `https://picsum.photos` at six shapes and sizes:
  landscape 1200x800, portrait 600x900, square 800x800, panoramic 1600x600, tall
  400x1000, and small 320x240.

Photos go through the real upload route, so each one lands in the local R2 bucket,
gets its `listing_photos` row, and gets the downscaled WebP card image from the
Images binding. The script then reads every original and card URL back over HTTP
and fails if one is not a 200 image response.

## Re-running

The script is idempotent. A second run signs in to the existing accounts, upserts
the same profiles, finds listings by their seed titles, and uploads only the photos
a listing is still missing. Nothing is duplicated.

## Safety

The script refuses to run, with a non-zero exit and no writes, when:

- `ENVIRONMENT` names a non-local environment (`production`, `prod`, `staging`, or
  `stage`),
- `NODE_ENV` names one of the same,
- `--remote` (or `--prod`) is passed, or
- the target base URL is not a loopback address (`localhost`, `127.0.0.1`, or
  `[::1]`).

It is a separate `pnpm seed` script and is not part of `build`, `deploy`, or any
startup path, so nothing in production reaches it.
