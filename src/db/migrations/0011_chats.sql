-- Migration number: 0011 	 2026-11-12T20:00:00.000Z

-- Append-only: 0001-0010 are already applied everywhere. This migration adds the
-- one-to-one chat that starts from a listing, and it touches no existing row.
--
-- `chats` is the thread between the listing's owner and one person who asked
-- about it. One person gets one thread per listing (`UNIQUE (listing_id,
-- seeker_user_id)`), so pressing the contact control twice opens the thread that
-- already exists instead of a second one. The two participant columns are the
-- durable record of who is in the thread; `chat_participants` is the same pair
-- as a per-person index that the inbox and the unread count read.
--
-- `last_seq` is the highest sequence number the chat object has allocated, kept
-- here so the inbox does not have to ask the object anything. It starts at zero
-- because the first message the object accepts takes seq 1. `last_message_at` is
-- null until the first message lands.
CREATE TABLE chats (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
   listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
seeker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
lister_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
last_message_at INTEGER,
     created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
   UNIQUE (listing_id, seeker_user_id),
   CHECK (seeker_user_id <> lister_user_id)
);

-- One row per side of a thread. `last_read_seq` is the highest sequence number
-- that person has read, so an unread message is one of the other side's rows
-- numbered above it - the inbox counts those and never asks the chat object.
CREATE TABLE chat_participants (
       chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX idx_chat_participants_user ON chat_participants(user_id, chat_id);

-- The message archive. `seq` is allocated by the chat object, which is the only
-- writer of this table, and it is the display order: `created_at` is wall-clock
-- data and two rows may share it. The unique `(chat_id, seq)` index makes a
-- duplicated sequence number impossible, and `(chat_id, client_message_id)`
-- makes a retried send land on the row it already wrote instead of a second one.
CREATE TABLE chat_messages (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
         chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL CHECK (seq > 0),
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
client_message_id TEXT NOT NULL CHECK (length(client_message_id) BETWEEN 1 AND 120),
     created_at INTEGER NOT NULL,
   UNIQUE (chat_id, seq),
   UNIQUE (chat_id, client_message_id)
);
