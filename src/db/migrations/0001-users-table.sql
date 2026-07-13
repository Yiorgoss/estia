-- 0001-user-table.sql

CREATE TABLE users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
           email TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
             age TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


 CREATE TRIGGER users_updated_at
AFTER UPDATE ON users
   FOR EACH ROW
   BEGIN
         UPDATE users
            SET updated_at = CURRENT_TIMESTAMP
          WHERE id = OLD.id;
   END;

