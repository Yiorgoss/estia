-- Migration number: 0011 	 2026-11-20T22:00:00.000Z

-- Append-only: earlier migrations are already applied everywhere. This
-- migration adds the one-to-one chat model: the chat row keyed on
-- (listing, seeker), the participant index holding the inbox projection and
-- unread count, and the append-only chat message archive written by the Chat
-- Durable Object.

CREATE TABLE chats (
                        id TEXT PRIMARY KEY,
                listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
                 seeker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 lister_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
         last_message_body TEXT,
    last_message_sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
           last_message_at INTEGER,
                created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    CHECK (seeker_id <> lister_id),
    UNIQUE (listing_id, seeker_id)
);

-- One row per participant per chat. `last_seq`, `last_message_at`, and
-- `unread_count` are maintained alongside each message write so the inbox query
-- reads strictly from D1 using `idx_chat_participants_inbox` without scanning
-- `chat_messages` or waking any Durable Object.
CREATE TABLE chat_participants (
           chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
           user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              role TEXT NOT NULL CHECK (role IN ('seeker', 'lister')),
     last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
          last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
      unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
   last_message_at INTEGER NOT NULL DEFAULT 0 CHECK (last_message_at >= 0),
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX idx_chat_participants_inbox
    ON chat_participants(user_id, last_message_at DESC, last_seq DESC, chat_id DESC);

-- Ordered per-chat archive. The Chat Durable Object is the sole writer and
-- allocates monotonically increasing `seq` values; `(chat_id, client_message_id)`
-- makes retries idempotent.
CREATE TABLE chat_messages (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
              chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                  seq INTEGER NOT NULL CHECK (seq > 0),
            sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL CHECK (length(trim(client_message_id)) BETWEEN 1 AND 128),
                 body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
           created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);

CREATE UNIQUE INDEX idx_chat_messages_chat_seq
    ON chat_messages(chat_id, seq);

CREATE UNIQUE INDEX idx_chat_messages_chat_client_id
    ON chat_messages(chat_id, client_message_id);
