ALTER TABLE invites ADD COLUMN known_personally boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT invited_known_note CHECK (NOT known_personally OR length(btrim(note)) >= 5);

ALTER TABLE users ADD COLUMN verification_source text;
UPDATE users SET verification_source = CASE verification_level WHEN 2 THEN 'DEAL' WHEN 1 THEN 'DOCUMENTS' END
  WHERE verification_level > 0;
ALTER TABLE users ADD CONSTRAINT users_verification_source_shape CHECK (
  (verification_level = 0 AND verification_source IS NULL)
  OR (verification_level = 1 AND verification_source IN ('DOCUMENTS','OPERATOR_KNOWN') AND verification_source IS NOT NULL)
  OR (verification_level = 2 AND verification_source = 'DEAL' AND verification_source IS NOT NULL)
);

-- Historical demo seed SQL is immutable. Direct level changes and old fixtures get the same source invariant.
CREATE FUNCTION prepare_verification_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  CASE NEW.verification_level
    WHEN 0 THEN NEW.verification_source := NULL;
    WHEN 1 THEN NEW.verification_source := CASE NEW.verification_source
      WHEN 'OPERATOR_KNOWN' THEN 'OPERATOR_KNOWN' ELSE 'DOCUMENTS' END;
    WHEN 2 THEN NEW.verification_source := 'DEAL';
    ELSE NULL;
  END CASE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_verification_source BEFORE INSERT OR UPDATE OF verification_level, verification_source
  ON users FOR EACH ROW EXECUTE FUNCTION prepare_verification_source();

ALTER TABLE listings DROP CONSTRAINT listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status IN ('ACTIVE','HIDDEN','FROZEN','BANNED','ARCHIVED','PENDING_OWNER','PENDING_REVIEW'));
ALTER TABLE listings ADD COLUMN created_by_staff uuid REFERENCES users(id),
  ADD COLUMN staff_source_note text,
  ADD COLUMN owner_confirmed_at timestamptz,
  ADD COLUMN review_reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN review_return_note text,
  ADD CONSTRAINT listings_staff_note CHECK (
    (created_by_staff IS NULL AND staff_source_note IS NULL) OR
    (created_by_staff IS NOT NULL AND staff_source_note IS NOT NULL AND length(btrim(staff_source_note)) BETWEEN 5 AND 500)
  ),
  ADD CONSTRAINT listings_review_return_note CHECK (length(review_return_note) <= 500);
CREATE INDEX listings_pending_owner_idx ON listings(created_at, owner_id) WHERE status = 'PENDING_OWNER';
CREATE INDEX listings_pending_review_idx ON listings(created_at) WHERE status = 'PENDING_REVIEW';

INSERT INTO platform_settings(key, value) VALUES ('feature_listing_premoderation', 'false');

CREATE OR REPLACE FUNCTION prepare_listing_actuality() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE planned_start timestamptz;
BEGIN
  IF NEW.status = 'HIDDEN' AND NEW.hidden_reason = 'SPOT_CHECK' THEN
    NEW.spot_check_hold := true;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT a.starts_at INTO planned_start FROM actuality_activation a, platform_settings s
      WHERE a.singleton AND s.key = 'feature_actuality' AND s.value = 'true'::jsonb;
    NEW.lifetime_days := coalesce(NEW.lifetime_days, CASE WHEN NEW.kind = 'BUY' THEN 21 ELSE 14 END);
    IF NEW.status IN ('PENDING_OWNER', 'PENDING_REVIEW') THEN
      NEW.expires_at := NULL;
      NEW.confirmed_at := NULL;
      RETURN NEW;
    END IF;
    NEW.expires_at := coalesce(NEW.expires_at, greatest(NEW.created_at, planned_start) + NEW.lifetime_days * interval '1 day');
    NEW.confirmed_at := coalesce(NEW.confirmed_at, NEW.created_at);
    RETURN NEW;
  END IF;

  IF NEW.lifetime_days IS DISTINCT FROM OLD.lifetime_days AND NEW.status IN ('ACTIVE', 'HIDDEN') THEN
    SELECT a.starts_at INTO planned_start FROM actuality_activation a, platform_settings s
      WHERE a.singleton AND s.key = 'feature_actuality' AND s.value = 'true'::jsonb;
    NEW.expires_at := greatest(now(), planned_start) + NEW.lifetime_days * interval '1 day';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'ACTIVE' AND OLD.status IN ('PENDING_OWNER', 'PENDING_REVIEW') THEN
    SELECT a.starts_at INTO planned_start FROM actuality_activation a, platform_settings s
      WHERE a.singleton AND s.key = 'feature_actuality' AND s.value = 'true'::jsonb;
    NEW.expires_at := greatest(now(), planned_start) + NEW.lifetime_days * interval '1 day';
    NEW.confirmed_at := now();
  ELSIF NEW.status IN ('PENDING_OWNER', 'PENDING_REVIEW') THEN
    NEW.expires_at := NULL;
    NEW.confirmed_at := NULL;
  END IF;
  IF NEW.status = 'ACTIVE' AND OLD.spot_check_hold THEN
    NEW.spot_check_hold := false;
  END IF;

  IF NEW.status <> 'HIDDEN' THEN
    NEW.hidden_at := NULL;
    NEW.hidden_reason := NULL;
  END IF;
  IF NEW.status <> 'ARCHIVED' THEN
    NEW.archived_at := NULL;
    NEW.archived_reason := NULL;
  ELSE
    NEW.archived_at := coalesce(NEW.archived_at, now());
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    DELETE FROM listing_actuality_asks
      WHERE listing_id = OLD.id AND asked_at = OLD.asked_at AND answered_at IS NULL AND missed_at IS NULL;
    NEW.asked_at := NULL;
    NEW.reminded_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION listing_trust_projection(listing_row listings, owner_row users) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'score', listing_row.trust_score,
    'ownerScore', owner_row.trust_score,
    'ownerLevel', owner_row.verification_level,
    'ownerLevelName', CASE owner_row.verification_level
      WHEN 2 THEN 'проверен сделкой'
      WHEN 1 THEN CASE owner_row.verification_source
        WHEN 'OPERATOR_KNOWN' THEN 'проверен оператором' ELSE 'проверен документами' END
      ELSE 'не проверен' END,
    'ownerLevelSource', owner_row.verification_source,
    'ownerDeals', owner_row.verified_deals_count,
    'reliable', coalesce(owner_row.trust_score >= 80, false),
    'proof', CASE WHEN listing_row.proof_status = 'VERIFIED' AND listing_row.proof_verified_at >= now()
      - CASE WHEN listing_row.kind = 'SELL' THEN interval '14 days' ELSE interval '30 days' END
      THEN CASE WHEN listing_row.kind = 'SELL' THEN 'STOCK' ELSE 'FUNDS' END END,
    'corridor', listing_row.corridor_outside
  )
$$;
