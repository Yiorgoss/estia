-- Migration number: 0003 	 2026-07-28T08:30:59.537Z

CREATE TABLE seekers (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
           name TEXT NOT NULL,  
            bio TEXT,
  date_of_birth DATETIME NOT NULL,
         gender TEXT NOT NULL CHECK (gender IN ('male', 'female', 'NB')),
        picture TEXT,
        smoking INTEGER NOT NULL DEFAULT 0 CHECK (smoking IN (0,1)),
           pets INTEGER NOT NULL DEFAULT 0 CHECK (pets IN (0,1)),
     created_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE listers (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        picture TEXT,
           name TEXT,  
      ownership TEXT NOT NULL DEFAULT 'owner' CHECK (ownership IN ('owner','leaseholder')),
     created_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE rooms (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
      lister_id INTEGER NOT NULL REFERENCES listers(id) ON DELETE CASCADE,
          price INTEGER NOT NULL, 
       location TEXT NOT NULL,
    description TEXT,
           size INTEGER,
      furnished INTEGER NOT NULL DEFAULT 0 CHECK (furnished IN (0,1)),
        ensuite INTEGER NOT NULL DEFAULT 0 CHECK (ensuite IN (0,1)),
        smoking INTEGER NOT NULL DEFAULT 0 CHECK (smoking IN (0,1)),
           pets INTEGER NOT NULL DEFAULT 0 CHECK (pets IN (0,1)),
 available_from DATE NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
     created_at DATETIME NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    FOREIGN KEY (lister_id) REFERENCES listers(id)
);

CREATE INDEX idx_rooms_lister ON rooms(lister_id);   
CREATE INDEX idx_rooms_location ON rooms(location);  
CREATE INDEX idx_rooms_price ON rooms(price);  
CREATE INDEX idx_rooms_furnished ON rooms(furnished);  
CREATE INDEX idx_rooms_pets ON rooms(pets);  
CREATE INDEX idx_rooms_smoking ON rooms(smoking);  
CREATE INDEX idx_rooms_available_from ON rooms(available_from);  

CREATE TABLE room_photos (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
       position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_room_photos_room ON room_photos(room_id);  



