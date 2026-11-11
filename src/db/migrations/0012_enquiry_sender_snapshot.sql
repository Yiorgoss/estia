-- Migration number: 0012 	 2026-11-12T09:00:00.000Z

-- Append-only: 0001-0011 are already applied everywhere, so this migration adds
-- the sender identity snapshot next to them.
--
-- An enquiry records what the lister was told when it was sent, so the sender's
-- display name and contact are captured on the row instead of being re-read from
-- the live profile. A later profile edit leaves the received record unchanged.
ALTER TABLE enquiries ADD COLUMN sender_name TEXT;

ALTER TABLE enquiries ADD COLUMN sender_contact TEXT;

UPDATE enquiries AS e
   SET sender_name = COALESCE(
         NULLIF(TRIM((SELECT s.name FROM seekers s WHERE s.user_id = e.sender_id)), ''),
         TRIM((SELECT u.email FROM users u WHERE u.id = e.sender_id))
       ),
       sender_contact = COALESCE(
         NULLIF(TRIM((SELECT s.contact FROM seekers s WHERE s.user_id = e.sender_id)), ''),
         TRIM((SELECT u.email FROM users u WHERE u.id = e.sender_id))
       );
