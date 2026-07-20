-- Migration number: 0002 	 2026-07-17T17:17:58.638Z

CREATE TABLE refresh_tokens (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,     
    device_info TEXT,                     -- optional: user agent, device name
     expires_at DATETIME NOT NULL,         
     created_at DATETIME DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
     revoked_at DATETIME,                   -- null = still valid
     ip_address TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);


CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);   -- for "get all sessions for this user"
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash); -- for "look up this exact token on refresh"
