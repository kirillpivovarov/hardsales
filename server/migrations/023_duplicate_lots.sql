INSERT INTO platform_settings (key, value) VALUES
  ('feature_lot_groups', 'false'), ('lot_price_tolerance', '0.05');

ALTER TABLE listings DROP CONSTRAINT listings_hidden_reason_check;
ALTER TABLE listings ADD CONSTRAINT listings_hidden_reason_check
  CHECK (hidden_reason IN ('NO_ANSWER', 'MISSED3', 'PAUSE', 'SPOT_CHECK', 'DUPLICATE'));
ALTER TABLE listings ADD COLUMN duplicate_of uuid REFERENCES listings(id);
ALTER TABLE listings ADD CONSTRAINT listings_duplicate_hidden
  CHECK (duplicate_of IS NULL OR (duplicate_of <> id AND status <> 'ACTIVE'));

CREATE FUNCTION lot_match_key(model text, amount integer, country text, city text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN model IS NOT NULL AND country IS NOT NULL THEN jsonb_build_array(
    model, amount, country, translate(lower(btrim(regexp_replace(city, '[[:space:]]+', ' ', 'g'))), 'ё', 'е')
  )::text END
$$;

ALTER TABLE listings ADD COLUMN lot_key text GENERATED ALWAYS AS (
  CASE WHEN kind = 'SELL' AND origin_scope IS DISTINCT FROM 'ANY' THEN lot_match_key(model_id, quantity, origin_country, stock_city) END
) STORED;
CREATE INDEX listing_lot_key_idx ON listings(lot_key, id) WHERE lot_key IS NOT NULL AND status IN ('ACTIVE', 'HIDDEN');

CREATE TABLE lot_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  model_id text NOT NULL REFERENCES hardware_models(id),
  lot_key text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISSOLVED')),
  primary_listing_id uuid REFERENCES listings(id),
  primary_state jsonb,
  shared_principal boolean,
  principal_owner_listing_id uuid REFERENCES listings(id),
  resolution text CHECK (resolution IN ('EXCLUSIVE_MANDATE', 'FIRST_CONFIRMED', 'PRINCIPAL_OWN', 'OPERATOR', 'DIFFERENT_LOTS')),
  resolution_note text CHECK (length(resolution_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  CHECK ((status = 'RESOLVED') = (primary_listing_id IS NOT NULL))
);
CREATE INDEX lot_groups_open_idx ON lot_groups(lot_key, number) WHERE status = 'OPEN';

CREATE TABLE lot_group_members (
  group_id uuid NOT NULL REFERENCES lot_groups(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'PRIMARY', 'DUPLICATE', 'REMOVED')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, listing_id)
);
CREATE UNIQUE INDEX lot_group_members_active_listing ON lot_group_members(listing_id) WHERE role IN ('MEMBER', 'PRIMARY');
CREATE INDEX lot_group_members_listing_idx ON lot_group_members(listing_id, group_id);

CREATE TABLE lot_principal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES lot_groups(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id),
  agent_id uuid NOT NULL REFERENCES users(id),
  asked_by uuid NOT NULL REFERENCES users(id),
  asked_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  principal_legal_name text CHECK (length(principal_legal_name) BETWEEN 2 AND 200),
  exclusive_mandate boolean,
  mandate_document_id uuid REFERENCES verification_documents(id) ON DELETE SET NULL,
  note text CHECK (length(note) <= 1000),
  UNIQUE (group_id, listing_id)
);
CREATE INDEX lot_principal_requests_agent_idx ON lot_principal_requests(agent_id, asked_at DESC);

CREATE TABLE lot_group_exclusions (
  listing_a uuid NOT NULL REFERENCES listings(id),
  listing_b uuid NOT NULL REFERENCES listings(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_a, listing_b),
  CHECK (listing_a < listing_b)
);

CREATE TABLE lot_duplicate_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES lot_groups(id),
  listing_id uuid NOT NULL REFERENCES listings(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX lot_duplicate_open_appeal ON lot_duplicate_appeals(listing_id) WHERE resolved_at IS NULL;

CREATE TABLE lot_detection_pending (
  lot_key text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX lot_detection_pending_order ON lot_detection_pending(queued_at, lot_key);

CREATE FUNCTION queue_listing_lots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.lot_key IS NOT NULL AND OLD.lot_key IS DISTINCT FROM NEW.lot_key THEN
    INSERT INTO lot_detection_pending(lot_key) VALUES (OLD.lot_key)
    ON CONFLICT (lot_key) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  IF NEW.lot_key IS NOT NULL THEN
    INSERT INTO lot_detection_pending(lot_key) VALUES (NEW.lot_key)
    ON CONFLICT (lot_key) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER queue_listing_lots_after_change
  AFTER INSERT OR UPDATE OF model_id, status, quantity, origin_scope, origin_country, stock_city,
    delivery_by, price, price_mode, currency, expires_at, representation, principal_id, duplicate_of
  ON listings FOR EACH ROW EXECUTE FUNCTION queue_listing_lots();
