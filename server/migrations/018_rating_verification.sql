ALTER TABLE users
  ADD COLUMN verification_level smallint NOT NULL DEFAULT 0 CHECK (verification_level BETWEEN 0 AND 2),
  ADD COLUMN verification_requested_at timestamptz,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verification_rejected_at timestamptz,
  ADD COLUMN verification_note text,
  ADD COLUMN publish_ban_at timestamptz,
  ADD COLUMN publish_ban_note text,
  ADD COLUMN link_group text CHECK (link_group ~ '^[a-z0-9-]{1,40}$'),
  ADD COLUMN trust_score smallint CHECK (trust_score BETWEEN 0 AND 100),
  ADD COLUMN trust_factors jsonb,
  ADD COLUMN trust_updated_at timestamptz,
  ADD COLUMN verified_deals_count integer NOT NULL DEFAULT 0 CHECK (verified_deals_count >= 0);

ALTER TABLE listings
  ADD COLUMN proof_status text NOT NULL DEFAULT 'NONE' CHECK (proof_status IN ('NONE', 'PENDING', 'VERIFIED')),
  ADD COLUMN proof_verified_at timestamptz,
  ADD COLUMN trust_score smallint CHECK (trust_score BETWEEN 0 AND 100),
  ADD COLUMN trust_factors jsonb,
  ADD COLUMN trust_updated_at timestamptz,
  ADD COLUMN corridor_outside boolean NOT NULL DEFAULT false;
CREATE INDEX listings_trust_idx ON listings(kind, trust_score DESC NULLS LAST, created_at DESC) WHERE status = 'ACTIVE';

CREATE TABLE verification_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  listing_id uuid REFERENCES listings(id),
  principal_id uuid REFERENCES user_principals(id),
  deal_id uuid,
  kind text NOT NULL CHECK (kind IN ('COMPANY_CARD', 'SIGNATORY', 'MANDATE', 'PRINCIPAL_LETTER', 'SERIAL_PHOTO',
    'WAREHOUSE_CERT', 'INVOICE', 'WAREHOUSE_VIDEO', 'LC_LETTER', 'FUNDS_PROOF', 'BANK_LETTER', 'DEAL_DOC', 'OTHER')),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 10485760),
  sha256 char(64) NOT NULL,
  day_code text,
  day_code_ok boolean,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  note text CHECK (length(note) <= 1000),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id)
);
CREATE INDEX verification_documents_queue_idx ON verification_documents(uploaded_at) WHERE status = 'PENDING';
CREATE INDEX verification_documents_user_idx ON verification_documents(user_id, uploaded_at DESC);

ALTER TABLE listings ADD COLUMN proof_document_id uuid REFERENCES verification_documents(id);

CREATE TABLE day_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  listing_id uuid REFERENCES listings(id),
  code text NOT NULL CHECK (code ~ '^[ABCDEFGHJKMNPRSTUVWXYZ][1-9]-[0-9]{4}$'),
  spot_check boolean NOT NULL DEFAULT false,
  issued_by uuid NOT NULL REFERENCES users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  result text CHECK (result IN ('PASSED', 'FAILED')),
  result_at timestamptz,
  UNIQUE (user_id, code)
);
CREATE INDEX day_codes_open_idx ON day_codes(expires_at) WHERE result IS NULL;

CREATE TABLE deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_id uuid NOT NULL UNIQUE REFERENCES disclosures(id),
  sell_listing_id uuid REFERENCES listings(id),
  buy_listing_id uuid REFERENCES listings(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'NEGOTIATING' CHECK (status IN ('NEGOTIATING', 'AGREED', 'FAILED', 'EXECUTED')),
  seller_agreed jsonb,
  buyer_agreed jsonb,
  amount_mismatch boolean NOT NULL DEFAULT false,
  failed_reason text,
  seller_executed_at timestamptz,
  buyer_executed_at timestamptz,
  admin_verified_at timestamptz,
  admin_rejected_at timestamptz,
  admin_note text,
  followups jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (seller_id <> buyer_id)
);
CREATE INDEX deals_seller_idx ON deals(seller_id);
CREATE INDEX deals_buyer_idx ON deals(buyer_id);
ALTER TABLE verification_documents ADD CONSTRAINT verification_documents_deal_fk FOREIGN KEY (deal_id) REFERENCES deals(id);

CREATE TABLE price_corridors (
  model_id text NOT NULL REFERENCES hardware_models(id),
  basis text NOT NULL CHECK (basis IN ('SELLER_WAREHOUSE', 'DELIVERED')),
  min_usd numeric(15, 2) NOT NULL CHECK (min_usd > 0),
  max_usd numeric(15, 2) NOT NULL,
  set_by uuid REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, basis),
  CHECK (max_usd >= min_usd)
);

CREATE TABLE user_penalties (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('DAY_CODE_SPOT_CHECK_FAILED', 'MISREPRESENTATION_PROVEN', 'OTHER')),
  points smallint NOT NULL CHECK (points BETWEEN 1 AND 100),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_penalties_user_idx ON user_penalties(user_id, created_at DESC);

ALTER TABLE verification_documents ADD COLUMN day_code_id uuid REFERENCES day_codes(id);
CREATE INDEX verification_documents_listing_idx ON verification_documents(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX verification_documents_deal_idx ON verification_documents(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX verification_documents_code_idx ON verification_documents(day_code_id) WHERE day_code_id IS NOT NULL;
CREATE INDEX deals_followups_idx ON deals(created_at) WHERE status IN ('NEGOTIATING', 'AGREED');

-- New first disclosures create a deal in the same transaction. Restored or
-- backfilled history never creates a retroactive deal.
CREATE FUNCTION disclosure_open_deal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  seller uuid;
  buyer uuid;
  offer uuid;
  request uuid;
BEGIN
  IF NEW.kind <> 'FIRST' OR NEW.migrated OR NOT EXISTS (
    SELECT 1 FROM platform_settings WHERE key = 'feature_trust_rating' AND value = 'true'::jsonb
  ) THEN
    RETURN NEW;
  END IF;
  SELECT id INTO seller FROM users WHERE id IN (NEW.user_a_id, NEW.user_b_id) AND role = 'SELLER';
  SELECT id INTO buyer FROM users WHERE id IN (NEW.user_a_id, NEW.user_b_id) AND role = 'BUYER';
  IF seller IS NULL OR buyer IS NULL THEN RETURN NEW; END IF;

  SELECT id INTO offer FROM listings WHERE id IN (NEW.listing_id, NEW.counter_listing_id)
    AND kind = 'SELL' AND owner_id = seller LIMIT 1;
  SELECT id INTO request FROM listings WHERE id IN (NEW.listing_id, NEW.counter_listing_id)
    AND kind = 'BUY' AND owner_id = buyer LIMIT 1;
  INSERT INTO deals (disclosure_id, sell_listing_id, buy_listing_id, seller_id, buyer_id, created_at)
  VALUES (NEW.id, offer, request, seller, buyer, NEW.accepted_at)
  ON CONFLICT (disclosure_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER disclosures_open_deal AFTER INSERT ON disclosures
  FOR EACH ROW EXECUTE FUNCTION disclosure_open_deal();

-- No private factors or numeric price corridor bounds leave this projection.
CREATE FUNCTION listing_trust_projection(listing_row listings, owner_row users) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'score', listing_row.trust_score,
    'ownerScore', owner_row.trust_score,
    'ownerLevel', owner_row.verification_level,
    'ownerLevelName', CASE owner_row.verification_level
      WHEN 2 THEN 'проверен сделкой' WHEN 1 THEN 'проверен документами' ELSE 'не проверен' END,
    'ownerDeals', owner_row.verified_deals_count,
    'reliable', coalesce(owner_row.trust_score >= 80, false),
    'proof', CASE WHEN listing_row.proof_status = 'VERIFIED' AND listing_row.proof_verified_at >= now()
      - CASE WHEN listing_row.kind = 'SELL' THEN interval '14 days' ELSE interval '30 days' END
      THEN CASE WHEN listing_row.kind = 'SELL' THEN 'STOCK' ELSE 'FUNDS' END END,
    'corridor', listing_row.corridor_outside
  )
$$;
CREATE UNIQUE INDEX day_codes_open_spot_check ON day_codes(listing_id) WHERE spot_check AND result IS NULL;
CREATE INDEX day_codes_spot_due_idx ON day_codes(issued_at) WHERE spot_check AND result IS NULL;
