-- Migration number: 0007 	 2026-11-11T20:45:00.000Z

-- Append-only: 0001-0006 are already applied everywhere. This migration adds the
-- saved searches a signed-in account keeps next to the listing feed; it does not
-- touch an existing table.
--
-- A saved search stores the same criteria the search feed filters on. Every
-- criterion is nullable because "any" is a real state: NULL means the search did
-- not narrow on that field. The flags keep the same `0 | 1 | NULL` shape the
-- listing table uses, so a saved `furnished = 0` is a filter, not an absent one.
CREATE TABLE saved_searches (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
           kind TEXT CHECK (kind IS NULL OR kind IN ('room', 'whole_property', 'room_wanted')),
    region_code TEXT REFERENCES regions(code),
 min_price_minor INTEGER CHECK (min_price_minor IS NULL OR min_price_minor >= 0),
 max_price_minor INTEGER CHECK (max_price_minor IS NULL OR max_price_minor >= 0),
    min_size_sqm INTEGER CHECK (min_size_sqm IS NULL OR min_size_sqm >= 0),
    max_size_sqm INTEGER CHECK (max_size_sqm IS NULL OR max_size_sqm >= 0),
      furnished INTEGER CHECK (furnished IS NULL OR furnished IN (0, 1)),
        ensuite INTEGER CHECK (ensuite IS NULL OR ensuite IN (0, 1)),
        smoking INTEGER CHECK (smoking IS NULL OR smoking IN (0, 1)),
           pets INTEGER CHECK (pets IS NULL OR pets IN (0, 1)),
 available_from INTEGER,
     created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    CHECK (min_price_minor IS NULL OR max_price_minor IS NULL OR min_price_minor <= max_price_minor),
    CHECK (min_size_sqm IS NULL OR max_size_sqm IS NULL OR min_size_sqm <= max_size_sqm),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_saved_searches_user ON saved_searches(user_id, created_at DESC, id DESC);
