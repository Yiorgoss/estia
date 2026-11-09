-- Migration number: 0006 	 2026-11-09T09:00:00.000Z

-- Append-only: 0001-0005 are already applied everywhere, so 0003 keeps creating
-- the seeker table with its columns NOT NULL and this migration relaxes them.
--
-- A profile row now exists from registration onward, before the person has filled
-- anything in, so a seeker row has to be insertable with no name, no date of
-- birth, and no gender. SQLite cannot drop a NOT NULL constraint in place, so the
-- table is rebuilt: create the new shape, copy every row verbatim, drop the old
-- table, rename the new one into its place. Existing rows keep exactly the values
-- they already had - no placeholder name, birth date, or gender is invented.
--
-- The rebuild is safe here because nothing references `seekers`: no other table
-- carries a foreign key into it, so dropping and renaming it cannot cascade
-- through a child row. That is not true of `users`, whose children (`seekers`,
-- `listers`, `refresh_tokens`, `listings`) do cascade - a rebuild of `users` would
-- delete those rows, so `users` is never migrated this way.
CREATE TABLE seekers_new (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
           name TEXT,
            bio TEXT,
  date_of_birth DATETIME,
         gender TEXT CHECK (gender IN ('male', 'female', 'NB')),
        smoking INTEGER NOT NULL DEFAULT 0 CHECK (smoking IN (0,1)),
           pets INTEGER NOT NULL DEFAULT 0 CHECK (pets IN (0,1)),
     created_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO seekers_new (id, user_id, name, bio, date_of_birth, gender, smoking, pets, created_at)
     SELECT id, user_id, name, bio, date_of_birth, gender, smoking, pets, created_at
       FROM seekers;

DROP TABLE seekers;

ALTER TABLE seekers_new RENAME TO seekers;
