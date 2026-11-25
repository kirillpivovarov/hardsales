CREATE TABLE user_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  number smallint NOT NULL CHECK (number BETWEEN 1 AND 999),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  company text NOT NULL DEFAULT '' CHECK (length(company) <= 160),
  platform_user_id uuid REFERENCES users(id),
  platform_fee_snapshot jsonb,
  email text CHECK (email IS NULL OR length(email) <= 254),
  confirmed_at timestamptz,
  confirmed_via text CHECK (confirmed_via IN ('EMAIL', 'PLATFORM', 'ADMIN')),
  confirmed_by jsonb,
  fee_confirmed_at timestamptz,
  email_ack jsonb,
  denied_at timestamptz,
  requested_at timestamptz,
  platform_requested_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, number),
  UNIQUE (id, user_id),
  CHECK ((confirmed_at IS NULL) = (confirmed_via IS NULL)),
  CHECK (platform_user_id IS DISTINCT FROM user_id)
);
CREATE INDEX user_principals_user_idx ON user_principals(user_id) WHERE removed_at IS NULL;
CREATE INDEX user_principals_unconfirmed_idx ON user_principals(created_at) WHERE confirmed_at IS NULL AND removed_at IS NULL;

CREATE TABLE company_email_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('PRINCIPAL', 'OWN')),
  user_id uuid NOT NULL REFERENCES users(id),
  principal_id uuid REFERENCES user_principals(id),
  to_email text NOT NULL CHECK (length(to_email) <= 254),
  domain_kind text NOT NULL CHECK (domain_kind IN ('CORPORATE', 'PUBLIC')),
  token_hash char(64) NOT NULL UNIQUE,
  outbox_id bigint REFERENCES exchange_email_outbox(id) ON DELETE SET NULL,
  fee_snapshot jsonb,
  status text NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'CONFIRMED', 'DECLINED', 'REPLACED', 'EXPIRED')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  delivery_attempts smallint NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 5),
  delivered_at timestamptz,
  answered_at timestamptz,
  answered_by_name text CHECK (answered_by_name IS NULL OR length(answered_by_name) BETWEEN 2 AND 120),
  answered_by_position text CHECK (answered_by_position IS NULL OR length(answered_by_position) <= 120),
  fee_answer text CHECK (fee_answer IN ('CONFIRMED', 'OTHER')),
  fee_other_value text CHECK (fee_other_value IS NULL OR length(fee_other_value) <= 120),
  FOREIGN KEY (principal_id, user_id) REFERENCES user_principals(id, user_id),
  CHECK ((kind = 'PRINCIPAL') = (principal_id IS NOT NULL))
);
CREATE INDEX company_email_letters_user_idx ON company_email_letters(user_id, sent_at DESC);
CREATE UNIQUE INDEX company_email_letters_outbox_idx ON company_email_letters(outbox_id) WHERE outbox_id IS NOT NULL;
CREATE UNIQUE INDEX company_email_letters_one_open
  ON company_email_letters(user_id, kind, coalesce(principal_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'SENT';

CREATE FUNCTION update_company_letter_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE company_email_letters SET delivery_status = NEW.status, delivery_attempts = NEW.attempts, delivered_at = NEW.sent_at
  WHERE outbox_id = NEW.id;
  RETURN NEW;
END
$$;
CREATE TRIGGER company_letter_delivery_sync AFTER UPDATE OF status, attempts, sent_at ON exchange_email_outbox
  FOR EACH ROW EXECUTE FUNCTION update_company_letter_delivery();

ALTER TABLE users
  ADD COLUMN company_email text,
  ADD COLUMN company_email_domain_kind text CHECK (company_email_domain_kind IN ('CORPORATE', 'PUBLIC')),
  ADD COLUMN company_email_confirmed_at timestamptz,
  ADD COLUMN agent_fee_disclosed boolean,
  ADD COLUMN agent_fee_kind text CHECK (agent_fee_kind IN ('PERCENT', 'PER_UNIT')),
  ADD COLUMN agent_fee_value numeric(12, 2) CHECK (agent_fee_value > 0),
  ADD COLUMN agent_fee_payer text CHECK (agent_fee_payer IN ('SELLER', 'BUYER', 'BOTH')),
  ADD COLUMN agent_fee_confirmed_at timestamptz,
  ADD COLUMN agent_fee_principal_says text,
  ADD COLUMN agent_fee_banned_until timestamptz;

ALTER TABLE listings
  ADD COLUMN representation text NOT NULL DEFAULT 'DIRECT' CHECK (representation IN ('DIRECT', 'AGENT')),
  ADD COLUMN principal_id uuid,
  ADD COLUMN agent_fee_disclosed boolean,
  ADD COLUMN agent_fee_kind text CHECK (agent_fee_kind IN ('PERCENT', 'PER_UNIT')),
  ADD COLUMN agent_fee_value numeric(12, 2) CHECK (agent_fee_value > 0),
  ADD COLUMN agent_fee_payer text CHECK (agent_fee_payer IN ('SELLER', 'BUYER', 'BOTH')),
  ADD CONSTRAINT listings_principal_owner_fk FOREIGN KEY (principal_id, owner_id) REFERENCES user_principals(id, user_id),
  ADD CONSTRAINT listings_representation_shape CHECK (
    (representation = 'DIRECT' AND principal_id IS NULL AND agent_fee_disclosed IS NULL) OR
    (representation = 'AGENT' AND principal_id IS NOT NULL AND agent_fee_disclosed IS NOT NULL AND
      (agent_fee_disclosed = false OR (agent_fee_kind IS NOT NULL AND agent_fee_value IS NOT NULL AND agent_fee_payer IS NOT NULL)))
  );
CREATE INDEX listings_principal_idx ON listings(principal_id) WHERE principal_id IS NOT NULL;
