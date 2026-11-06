-- Migration number: 0005 	 2026-10-23T09:00:00.000Z

-- Append-only: 0001-0004 are already applied everywhere, so 0003 keeps creating
-- the legacy `rooms` tables and this migration removes them. The unified
-- listings model replaced the room surface, so nothing reads these tables.
-- `room_photos` goes first because it holds the foreign key into `rooms`; the
-- `listers`/`seekers` profile tables stay, since they are identity rather than
-- rooms.
DROP TABLE room_photos;

DROP TABLE rooms;
