INSERT INTO platform_settings (key, value) VALUES
  ('pd_policy_version', '"0.1"'),
  ('third_party_letter', '{"approved":false,"subject":"","body":"","approvedAt":null,"approvedBy":null}');

INSERT INTO site_content (key, translations) VALUES
  ('pd_policy', '{"ru":{"title":"Политика обработки персональных данных","body":"Текст политики утверждает владелец площадки. До утверждения регистрация новых участников недоступна."}}')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE users
  ADD COLUMN pd_consent_version text,
  ADD COLUMN pd_consent_at timestamptz,
  ADD COLUMN info_email_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT users_deleted_status CHECK (deleted_at IS NULL OR status='BANNED');

CREATE TABLE user_consents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('PD_PROCESSING', 'INFO_EMAIL')),
  granted boolean NOT NULL,
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 32),
  given_at timestamptz NOT NULL,
  ip inet,
  user_agent text CHECK (length(user_agent) <= 300),
  source text NOT NULL CHECK (source IN ('REGISTRATION', 'LOGIN', 'PROFILE', 'MIGRATION'))
);
CREATE INDEX user_consents_user_idx ON user_consents(user_id, id DESC);

CREATE FUNCTION reject_consent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Запись о согласии не изменяется и не удаляется';
END;
$$;
CREATE TRIGGER user_consents_immutable BEFORE UPDATE OR DELETE ON user_consents
  FOR EACH ROW EXECUTE FUNCTION reject_consent_mutation();

CREATE TABLE email_suppressions (
  email_hash char(64) PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('RECIPIENT_OPT_OUT', 'ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE exchange_email_outbox ADD COLUMN respects_opt_out boolean NOT NULL DEFAULT false;
UPDATE exchange_email_outbox o SET respects_opt_out=true
FROM company_email_letters c WHERE c.outbox_id=o.id;
-- The previous template was never approved. Already delivered letters remain answerable.
UPDATE company_email_letters c SET status='EXPIRED'
FROM exchange_email_outbox o WHERE c.outbox_id=o.id AND c.status='SENT' AND o.status='PENDING';
UPDATE exchange_email_outbox SET status='SKIPPED' WHERE respects_opt_out AND status='PENDING';

CREATE TABLE data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('EXPORT', 'DELETE')),
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'DONE', 'REJECTED')),
  comment text CHECK (length(comment) <= 1000),
  requested_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid REFERENCES users(id),
  handled_at timestamptz,
  handler_note text CHECK (length(handler_note) <= 1000),
  export_content bytea CHECK (octet_length(export_content) <= 20971520),
  export_expires_at timestamptz
);
CREATE INDEX data_requests_queue_idx ON data_requests(requested_at) WHERE status = 'NEW';
CREATE INDEX data_requests_export_due_idx ON data_requests(export_expires_at) WHERE export_content IS NOT NULL;
CREATE UNIQUE INDEX data_requests_one_open ON data_requests(user_id, kind) WHERE status = 'NEW';

ALTER TABLE moderation_audit DROP CONSTRAINT moderation_audit_actor_role_check;
ALTER TABLE moderation_audit ADD CONSTRAINT moderation_audit_actor_role_check
  CHECK (actor_role IN ('ADMIN','MODERATOR','AGENT','BUYER','SELLER'));
