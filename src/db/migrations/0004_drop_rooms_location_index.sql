-- Migration number: 0004 	 2026-11-06T09:10:29.000Z

-- `idx_rooms_location` only served the removed exact-match `findWithFilters`
-- query; no remaining query filters or sorts on `rooms.location`.
DROP INDEX IF EXISTS idx_rooms_location;
