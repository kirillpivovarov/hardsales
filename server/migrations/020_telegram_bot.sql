INSERT INTO platform_settings (key, value) VALUES ('feature_telegram', 'false');

UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id IS NOT NULL;
ALTER TABLE users
  ADD COLUMN telegram_user_id bigint,
  ADD COLUMN telegram_username text CHECK (telegram_username IS NULL OR length(telegram_username) <= 64),
  ADD COLUMN telegram_linked_at timestamptz,
  ADD COLUMN telegram_disabled_at timestamptz,
  ADD COLUMN telegram_disabled_reason text CHECK (telegram_disabled_reason IN ('USER_STOP', 'PROFILE_UNLINK', 'BOT_BLOCKED', 'CHAT_NOT_FOUND', 'ADMIN'));
CREATE UNIQUE INDEX users_telegram_chat_unique ON users(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
CREATE UNIQUE INDEX users_telegram_user_unique ON users(telegram_user_id) WHERE telegram_chat_id IS NOT NULL;

ALTER TABLE notification_deliveries
  ADD COLUMN telegram_message_id bigint,
  ADD COLUMN fallback_for bigint REFERENCES notification_deliveries(id) ON DELETE SET NULL;
CREATE INDEX notification_deliveries_fallback_idx ON notification_deliveries(fallback_for) WHERE fallback_for IS NOT NULL;

CREATE TABLE telegram_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('MESSAGE', 'CALLBACK', 'OTHER')),
  handled boolean NOT NULL DEFAULT false
);
CREATE INDEX telegram_updates_received_idx ON telegram_updates(received_at);

CREATE TABLE telegram_dialogs (
  chat_id bigint PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  action_index smallint NOT NULL CHECK (action_index BETWEEN 0 AND 49),
  expects text NOT NULL CHECK (expects IN ('ACTUALITY_CHANGE', 'PRINCIPAL_AMOUNT')),
  source_message_id bigint NOT NULL,
  prompt_message_id bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);

CREATE TABLE telegram_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  bot_username text,
  polling_offset bigint NOT NULL DEFAULT 0,
  webhook_set_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  send_retry_at timestamptz
);
INSERT INTO telegram_state DEFAULT VALUES;

CREATE TABLE telegram_delivery_recipient_limits (
  chat_id bigint PRIMARY KEY,
  sent_at timestamptz NOT NULL
);
CREATE TABLE telegram_delivery_rate_window (
  sent_at timestamptz NOT NULL
);
