ALTER TABLE listings
  ADD COLUMN min_lot integer NOT NULL DEFAULT 1 CHECK (min_lot >= 1),
  ADD COLUMN ship_days smallint CHECK (ship_days BETWEEN 0 AND 365),
  ADD COLUMN payment_terms text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT listings_min_lot_le_quantity CHECK (min_lot <= quantity),
  ADD CONSTRAINT listings_ship_days_sell_only CHECK (kind = 'SELL' OR ship_days IS NULL),
  ADD CONSTRAINT listings_payment_terms_valid CHECK (payment_terms <@ ARRAY[
    'PREPAY_100','DEPOSIT_INSPECTION','ESCROW','LC_CONFIRMED','LC_TRANSFERABLE','LC_BACK_TO_BACK',
    'BANK_GUARANTEE','PAY_AFTER_INSPECTION','STABLECOIN_ESCROW','DEFERRED_FINANCING']::text[]);

CREATE TABLE fx_rates (
  currency text PRIMARY KEY CHECK (currency IN ('RUB', 'USD', 'EUR', 'CNY', 'KZT', 'AED')),
  usd_per_unit numeric(18, 8) CHECK (usd_per_unit > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fx_rates (currency, usd_per_unit) VALUES
  ('USD', 1), ('AED', 0.2723), ('CNY', 0.1385), ('EUR', 1.08), ('RUB', 0.0105), ('KZT', NULL);

CREATE TABLE listing_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  sell_listing_id uuid NOT NULL REFERENCES listings(id),
  buy_listing_id uuid NOT NULL REFERENCES listings(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('FULL', 'PARTIAL')),
  mismatches jsonb NOT NULL DEFAULT '[]',
  common_terms text[] NOT NULL DEFAULT '{}',
  common_methods text[] NOT NULL DEFAULT '{}',
  gap jsonb,
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CHAT', 'DECLINED', 'VOID')),
  previous_status text CHECK (previous_status IN ('NEW', 'CHAT')),
  void_reason text,
  declined_by uuid REFERENCES users(id),
  decline_reason text,
  chat_id uuid REFERENCES chats(id),
  initial_batch boolean NOT NULL DEFAULT false,
  seller_notified_at timestamptz,
  buyer_notified_at timestamptz,
  seller_first_action_at timestamptz,
  buyer_first_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sell_listing_id, buy_listing_id),
  CHECK (seller_id <> buyer_id)
);
CREATE INDEX listing_matches_seller_idx ON listing_matches(seller_id, updated_at DESC);
CREATE INDEX listing_matches_buyer_idx ON listing_matches(buyer_id, updated_at DESC);
CREATE INDEX listing_matches_open_idx ON listing_matches(status) WHERE status IN ('NEW', 'CHAT');
CREATE INDEX listing_matches_sell_listing_idx ON listing_matches(sell_listing_id);
CREATE INDEX listing_matches_buy_listing_idx ON listing_matches(buy_listing_id);
CREATE INDEX listing_matches_chat_idx ON listing_matches(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX listings_match_sell_idx ON listings(model_id, confirmed_at DESC, id)
  WHERE kind = 'SELL' AND status = 'ACTIVE';

ALTER TABLE chats ADD COLUMN match_id uuid REFERENCES listing_matches(id);
ALTER TABLE disclosures ADD CONSTRAINT disclosures_match_fk FOREIGN KEY (match_id) REFERENCES listing_matches(id);

-- Mutations queue affected rows even if a concurrently running matcher owns the lock.
CREATE TABLE matching_pending (
  listing_id uuid PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX matching_pending_queue_idx ON matching_pending(queued_at, listing_id);

CREATE FUNCTION queue_listing_match() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_id IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.model_id IS NOT NULL) THEN
    INSERT INTO matching_pending(listing_id) VALUES (NEW.id)
    ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER queue_listing_match_after_change
  AFTER INSERT OR UPDATE OF model_id, analog_model_ids, status, condition, quantity, min_lot,
    origin_scope, origin_country, destination_country, counterparty, ship_days, delivery_by,
    payment_methods, payment_terms, price, price_mode, currency, confirmed_at, expires_at, representation
  ON listings FOR EACH ROW EXECUTE FUNCTION queue_listing_match();

CREATE FUNCTION queue_model_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO matching_pending(listing_id)
      SELECT id FROM listings WHERE model_id = NEW.id OR analog_model_ids @> ARRAY[NEW.id]
    ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER queue_model_matches_after_change
  AFTER UPDATE OF status ON hardware_models FOR EACH ROW EXECUTE FUNCTION queue_model_matches();

CREATE FUNCTION queue_owner_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status, NEW.email_verified_at, NEW.participant_type, NEW.onboarding_state, NEW.actuality_suspended_at)
    IS DISTINCT FROM (OLD.status, OLD.email_verified_at, OLD.participant_type, OLD.onboarding_state, OLD.actuality_suspended_at) THEN
    INSERT INTO matching_pending(listing_id)
      SELECT id FROM listings WHERE owner_id = NEW.id AND model_id IS NOT NULL
    ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER queue_owner_matches_after_change
  AFTER UPDATE OF status, email_verified_at, participant_type, onboarding_state, actuality_suspended_at ON users
  FOR EACH ROW EXECUTE FUNCTION queue_owner_matches();

CREATE FUNCTION queue_enabled_matching() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key = 'feature_matching' AND NEW.value = 'true'::jsonb AND NEW.value IS DISTINCT FROM OLD.value THEN
    DELETE FROM job_runs WHERE job = 'matching.recompute' AND stats->>'enabled' = 'false';
    INSERT INTO matching_pending(listing_id)
      SELECT id FROM listings WHERE kind = 'BUY' AND model_id IS NOT NULL
    ON CONFLICT (listing_id) DO UPDATE SET queued_at = EXCLUDED.queued_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER queue_enabled_matching_after_change
  AFTER UPDATE OF value ON platform_settings FOR EACH ROW EXECUTE FUNCTION queue_enabled_matching();
