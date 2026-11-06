-- Migration number: 0004 	 2026-10-22T09:00:00.000Z

-- Append-only: 0001-0003 are already applied everywhere. This migration adds the
-- unified listings model next to the legacy `rooms` table; it does not touch it.

-- Controlled Greek region reference set: the 13 administrative regions.
-- The listings FK makes this the integrity guarantee; the TypeScript
-- `GreekRegionCodes` literal mirrors it and a pinning test keeps them identical.
CREATE TABLE regions (
       code TEXT PRIMARY KEY,
       name TEXT NOT NULL UNIQUE
);

INSERT INTO regions (code, name) VALUES
  ('attica', 'Attica'),
  ('central_greece', 'Central Greece'),
  ('central_macedonia', 'Central Macedonia'),
  ('crete', 'Crete'),
  ('eastern_macedonia_and_thrace', 'Eastern Macedonia and Thrace'),
  ('epirus', 'Epirus'),
  ('ionian_islands', 'Ionian Islands'),
  ('north_aegean', 'North Aegean'),
  ('peloponnese', 'Peloponnese'),
  ('south_aegean', 'South Aegean'),
  ('thessaly', 'Thessaly'),
  ('western_greece', 'Western Greece'),
  ('western_macedonia', 'Western Macedonia');

-- One table for all three things people post: a room, a whole property, and a
-- room-wanted ad. `kind` says which; `owner_id` is always the user account, so
-- creation does not depend on lister/seeker profile provisioning.
CREATE TABLE listings (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
               kind TEXT NOT NULL CHECK (kind IN ('room', 'whole_property', 'room_wanted')),
           owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished')),
              title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
        description TEXT CHECK (description IS NULL OR length(description) <= 5000),
        price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
           currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR')),
        region_code TEXT NOT NULL REFERENCES regions(code),
                lat REAL CHECK (lat IS NULL OR (lat BETWEEN 34.0 AND 42.5)),
                lng REAL CHECK (lng IS NULL OR (lng BETWEEN 19.0 AND 30.5)),
           size_sqm INTEGER CHECK (size_sqm IS NULL OR size_sqm > 0),
     available_from INTEGER,
          furnished INTEGER NOT NULL DEFAULT 0 CHECK (furnished IN (0, 1)),
            ensuite INTEGER NOT NULL DEFAULT 0 CHECK (ensuite IN (0, 1)),
            smoking INTEGER NOT NULL DEFAULT 0 CHECK (smoking IN (0, 1)),
               pets INTEGER NOT NULL DEFAULT 0 CHECK (pets IN (0, 1)),
         created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
         updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
       published_at INTEGER,
    CHECK ((lat IS NULL) = (lng IS NULL)),
    CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE INDEX idx_listings_owner ON listings(owner_id, created_at DESC, id DESC);
CREATE INDEX idx_listings_feed ON listings(status, created_at DESC, id DESC);
CREATE INDEX idx_listings_feed_kind ON listings(status, kind, created_at DESC, id DESC);
CREATE INDEX idx_listings_region_price ON listings(status, region_code, price_minor);
CREATE INDEX idx_listings_available_from ON listings(status, available_from);
