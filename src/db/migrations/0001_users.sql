-- 0001-user-table.sql

CREATE TABLE users (
              id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
           email TEXT NOT NULL UNIQUE, 
            role TEXT NOT NULL CHECK (role IN ('seeker', 'lister', 'user','admin' )) DEFAULT 'user',
   password_hash TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
      updated_at DATETIME NOT NULL  DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)) -- easy to convert to js time
);

 CREATE TRIGGER users_updated_at
AFTER UPDATE ON users
   FOR EACH ROW
   BEGIN
         UPDATE users
            SET updated_at = (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
          WHERE id = OLD.id;
   END;

