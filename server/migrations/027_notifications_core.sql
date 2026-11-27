CREATE TABLE chat_notify_state (
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_email_at timestamptz,
  last_telegram_at timestamptz,
  pending_since timestamptz,
  pending_message_id bigint,
  PRIMARY KEY (chat_id, user_id),
  CHECK ((pending_since IS NULL) = (pending_message_id IS NULL))
);
CREATE INDEX chat_notify_pending_idx ON chat_notify_state(pending_since) WHERE pending_since IS NOT NULL;

ALTER TABLE notifications
  ADD COLUMN priority smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  ADD COLUMN delivery_only boolean NOT NULL DEFAULT false;

CREATE INDEX chat_notifications_unread_idx ON notifications(user_id, (payload->>'chatId'))
  WHERE kind='chat.message' AND NOT delivery_only AND read_at IS NULL;

CREATE TABLE staff_notify_state (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  last_email_at timestamptz NOT NULL,
  first_notice_id bigint NOT NULL,
  has_pending boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, kind)
);

INSERT INTO platform_settings (key, value) VALUES
  ('staff_digest_hour', '9'),
  ('staff_instant_kinds',
   '["onboarding.submitted","verification.document_uploaded","deal.executed","deal.amount_mismatch","listing.pending_review","dispute.opened","dispute.reopened"]');
