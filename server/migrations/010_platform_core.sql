CREATE TABLE platform_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value) VALUES
  ('timezone', '"Europe/Moscow"'),
  ('rules_version', '"1.0"'),
  ('registration_mode', '"OPEN"'),
  ('feature_invites', 'false'),
  ('feature_actuality', 'false'),
  ('feature_disclosure_journal', 'false'),
  ('feature_representation', 'false'),
  ('feature_matching', 'false'),
  ('feature_trust_rating', 'false'),
  ('feature_catalog_sync', 'false'),
  ('disclosure_min_level', '0'),
  ('low_rating_threshold', '30'),
  ('catalog_sync_vendors', '["10de"]');

CREATE TABLE job_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job text NOT NULL,
  slot text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'DONE', 'FAILED', 'SKIPPED')),
  attempts smallint NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}',
  error text,
  retry_at timestamptz,
  UNIQUE (job, slot)
);
CREATE INDEX job_runs_recent_idx ON job_runs(job, started_at DESC);

CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{2,63}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  payload jsonb NOT NULL DEFAULT '{}',
  actions jsonb NOT NULL DEFAULT '[]',
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications(user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE notification_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('EMAIL', 'TELEGRAM')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text,
  UNIQUE (notification_id, channel)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries(next_attempt_at) WHERE status = 'PENDING';

CREATE TABLE exchange_email_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX exchange_email_due_idx ON exchange_email_outbox(next_attempt_at) WHERE status = 'PENDING';

ALTER TABLE users ADD COLUMN notify_email boolean NOT NULL DEFAULT true, ADD COLUMN telegram_chat_id bigint;

CREATE TABLE action_tokens (
  token_hash char(64) PRIMARY KEY,
  purpose text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_tokens_expiry_idx ON action_tokens(expires_at);
