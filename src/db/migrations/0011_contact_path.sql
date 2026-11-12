-- Migration number: 0011 	 2026-11-11T20:00:00.000Z

-- Append-only: 0001-0010 are already applied everywhere, so this migration adds
-- the contact path next to them.
--
-- A person opts in to being reachable by filling in `contact`. It is a free-text
-- line - whatever they chose to publish, not a controlled format - and it is
-- null until they do. The 200-character bound is the same at the HTTP boundary;
-- the CHECK here is the last line of defence.
ALTER TABLE seekers ADD COLUMN contact TEXT CHECK (contact IS NULL OR length(contact) <= 200);

ALTER TABLE listers ADD COLUMN contact TEXT CHECK (contact IS NULL OR length(contact) <= 200);

-- One row per enquiry: a signed-in account's short message against one listing,
-- with the sender's account as the identity. The sender is never request data;
-- it is the account the session cookie proves. A listing that is deleted takes
-- its enquiries with it, and so does a deleted account.
--
-- There is no thread, no read receipt, and no reply: the lister reads the
-- enquiry and answers on the identity captured when it was sent (0012 adds
-- that snapshot).
CREATE TABLE enquiries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
   listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
   created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);

-- The lister's list reads by listing owner (through listings), the sender's list
-- reads by sender, and the per-sender rate limit counts a sender's recent rows.
CREATE INDEX idx_enquiries_listing ON enquiries(listing_id, created_at DESC, id DESC);
CREATE INDEX idx_enquiries_sender ON enquiries(sender_id, created_at DESC, id DESC);
