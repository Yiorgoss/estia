-- 0001-user-table.sql

CREATE TABLE users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
           email TEXT NOT NULL UNIQUE, -- doesnt need index
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'owner', 'admin', 'moderator')) DEFAULT 'user',
   password_hash TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT ,
      updated_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);


 CREATE TRIGGER users_updated_at
AFTER UPDATE ON users
   FOR EACH ROW
   BEGIN
         UPDATE users
            SET updated_at = (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
          WHERE id = OLD.id;
   END;

