CREATE TABLE contact_block_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  surface text NOT NULL CHECK (surface IN ('CHAT', 'LISTING', 'PROFILE', 'REVIEW', 'REPORT')),
  chat_id uuid REFERENCES chats(id) ON DELETE SET NULL,
  listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  kinds text[] NOT NULL CHECK (cardinality(kinds) > 0),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_block_events_user_created ON contact_block_events(user_id, created_at DESC);
CREATE INDEX contact_block_events_created ON contact_block_events(created_at DESC, id DESC);

ALTER TABLE chat_messages ADD COLUMN hidden_for_peer boolean NOT NULL DEFAULT false;
CREATE INDEX chat_messages_guard_recent ON chat_messages(chat_id, sender_id, id DESC);

-- Server startup classifies the fixed pre-migration range with the same detector as live writes.
CREATE TABLE contact_guard_backfill (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_message_id bigint NOT NULL DEFAULT 0,
  through_message_id bigint NOT NULL
);
INSERT INTO contact_guard_backfill(through_message_id) SELECT coalesce(max(id), 0) FROM chat_messages;

ALTER TABLE reports DROP CONSTRAINT reports_reason_check,
  ALTER COLUMN reporter_id DROP NOT NULL,
  ALTER COLUMN chat_id DROP NOT NULL,
  ADD COLUMN listing_id uuid REFERENCES listings(id),
  ADD CONSTRAINT reports_reason_check CHECK (reason IN ('FRAUD','ABUSE','OTHER','CONTACT_BYPASS','CONTACT_PHOTO')),
  ADD CONSTRAINT reports_location_check CHECK (
    (reason = 'CONTACT_BYPASS' AND reporter_id IS NULL) OR
    (reason = 'CONTACT_PHOTO' AND reporter_id IS NOT NULL AND listing_id IS NOT NULL AND chat_id IS NULL) OR
    (reason NOT IN ('CONTACT_BYPASS','CONTACT_PHOTO') AND reporter_id IS NOT NULL AND chat_id IS NOT NULL AND listing_id IS NULL)
  );
CREATE UNIQUE INDEX reports_open_contact_bypass ON reports(subject_id) WHERE reason = 'CONTACT_BYPASS' AND status = 'OPEN';
CREATE UNIQUE INDEX reports_contact_photo_reporter ON reports(listing_id, reporter_id) WHERE reason = 'CONTACT_PHOTO';
