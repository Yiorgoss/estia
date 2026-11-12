-- Migration number: 0010 	 2026-11-11T11:00:00.000Z

-- Append-only: earlier migrations are already applied everywhere. This migration
-- adds the downscaled card image a gallery photo may have; it does not touch an
-- existing row.
--
-- `thumbnail_key` is null when no downscaled copy exists, which is the card's
-- cue to serve the original. The card image is always WebP, so its content type
-- is a constant rather than a column, and its size ceiling is enforced by the
-- service on the produced bytes before the object is stored: this column holds
-- only the key, so a CHECK here cannot see the size.
ALTER TABLE listing_photos ADD COLUMN thumbnail_key TEXT;
