INSERT INTO platform_settings (key, value) VALUES
  ('near_miss_max_failures', '2'),
  ('near_miss_price_over', '0.2');

ALTER TABLE listing_matches
  ADD COLUMN source text NOT NULL DEFAULT 'SYSTEM' CHECK (source IN ('SYSTEM', 'OPERATOR')),
  ADD COLUMN operator_comment text CHECK (length(operator_comment) BETWEEN 10 AND 1000),
  ADD COLUMN proposed_by uuid REFERENCES users(id),
  ADD COLUMN proposed_at timestamptz,
  ADD COLUMN operator_failures jsonb,
  ADD COLUMN operator_model_id text REFERENCES hardware_models(id),
  ADD CONSTRAINT listing_matches_operator_shape CHECK (
    (source = 'SYSTEM' AND proposed_by IS NULL AND operator_comment IS NULL AND proposed_at IS NULL
      AND operator_failures IS NULL AND operator_model_id IS NULL)
    OR (source = 'OPERATOR' AND proposed_by IS NOT NULL AND operator_comment IS NOT NULL AND proposed_at IS NOT NULL
      AND operator_failures IS NOT NULL AND jsonb_typeof(operator_failures) = 'array')
  );
CREATE INDEX listing_matches_source_idx ON listing_matches(source, created_at DESC);

CREATE TABLE near_miss_dismissals (
  sell_listing_id uuid NOT NULL REFERENCES listings(id),
  buy_listing_id uuid NOT NULL REFERENCES listings(id),
  dismissed_by uuid NOT NULL REFERENCES users(id),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (length(note) <= 500),
  PRIMARY KEY (sell_listing_id, buy_listing_id),
  CHECK (sell_listing_id <> buy_listing_id)
);

CREATE INDEX moderation_audit_match_proposals_idx ON moderation_audit(created_at DESC)
  WHERE entity = 'matches' AND action = 'propose';

-- Model-less listings can now participate in a manually proposed match.
CREATE OR REPLACE FUNCTION queue_listing_match() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_id IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.model_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM listing_matches WHERE sell_listing_id = NEW.id OR buy_listing_id = NEW.id) THEN
    INSERT INTO matching_pending(listing_id) VALUES (NEW.id)
    ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION queue_model_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO matching_pending(listing_id)
      SELECT id FROM listings WHERE model_id = NEW.id OR analog_model_ids @> ARRAY[NEW.id]
      UNION SELECT sell_listing_id FROM listing_matches WHERE operator_model_id = NEW.id
    ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION queue_owner_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status, NEW.email_verified_at, NEW.participant_type, NEW.onboarding_state, NEW.actuality_suspended_at)
    IS DISTINCT FROM (OLD.status, OLD.email_verified_at, OLD.participant_type, OLD.onboarding_state, OLD.actuality_suspended_at) THEN
    INSERT INTO matching_pending(listing_id)
      SELECT l.id FROM listings l WHERE l.owner_id = NEW.id AND (
        l.model_id IS NOT NULL OR EXISTS (SELECT 1 FROM listing_matches m WHERE m.sell_listing_id = l.id OR m.buy_listing_id = l.id)
      )
    ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END;
$$;
