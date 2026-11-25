ALTER TABLE listings DROP CONSTRAINT listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status IN ('ACTIVE', 'HIDDEN', 'FROZEN', 'BANNED', 'ARCHIVED'));

ALTER TABLE listings
  ADD COLUMN lifetime_days smallint CHECK (lifetime_days BETWEEN 1 AND 60),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN asked_at timestamptz,
  ADD COLUMN reminded_at timestamptz,
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_reason text CHECK (hidden_reason IN ('NO_ANSWER', 'MISSED3', 'PAUSE', 'SPOT_CHECK')),
  ADD COLUMN spot_check_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_reason text CHECK (archived_reason IN
    ('OWNER', 'EXPIRED', 'HIDDEN_7D', 'SOLD_PLATFORM', 'SOLD_OUTSIDE', 'CANCELLED')),
  ADD CONSTRAINT listings_hidden_shape
    CHECK ((status = 'HIDDEN' AND hidden_reason IS NOT NULL AND hidden_at IS NOT NULL)
      OR (status <> 'HIDDEN' AND hidden_reason IS NULL AND hidden_at IS NULL));

UPDATE listings SET
  lifetime_days = CASE WHEN kind = 'BUY' THEN 21 ELSE 14 END,
  expires_at = CASE WHEN status = 'ACTIVE' THEN now() + (CASE WHEN kind = 'BUY' THEN 21 ELSE 14 END) * interval '1 day' END,
  confirmed_at = updated_at,
  archived_at = CASE WHEN status = 'ARCHIVED' THEN updated_at END,
  archived_reason = CASE WHEN status = 'ARCHIVED' THEN 'OWNER' END;

ALTER TABLE listings ALTER COLUMN lifetime_days SET NOT NULL;
CREATE INDEX listings_asked_idx ON listings(asked_at) WHERE status = 'ACTIVE' AND asked_at IS NOT NULL;
CREATE INDEX listings_hidden_idx ON listings(hidden_at) WHERE status = 'HIDDEN';
CREATE INDEX listings_expiry_idx ON listings(expires_at) WHERE status IN ('ACTIVE', 'HIDDEN');

CREATE TABLE listing_actuality_asks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES listings(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  local_date date NOT NULL,
  asked_at timestamptz NOT NULL,
  answered_at timestamptz,
  answer text CHECK (answer IN ('ACTUAL', 'CHANGED', 'WITHDRAWN', 'EDITED', 'PAUSE')),
  on_time boolean,
  missed_at timestamptz,
  UNIQUE (listing_id, local_date),
  CHECK (NOT (answered_at IS NOT NULL AND missed_at IS NOT NULL))
);
CREATE INDEX listing_actuality_asks_owner_idx ON listing_actuality_asks(owner_id, asked_at DESC);
CREATE INDEX listing_actuality_asks_missed_idx ON listing_actuality_asks(owner_id, local_date) WHERE missed_at IS NOT NULL;

CREATE TABLE listing_price_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES listings(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('CREATE', 'EDIT', 'ACTUALITY')),
  quantity integer NOT NULL,
  price numeric(15, 2),
  currency text NOT NULL
);
CREATE INDEX listing_price_history_idx ON listing_price_history(listing_id, changed_at DESC);

INSERT INTO listing_price_history (listing_id, changed_at, source, quantity, price, currency)
SELECT id, created_at, 'CREATE', quantity, price, currency FROM listings;

CREATE TABLE user_pauses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX user_pauses_one_open ON user_pauses(user_id) WHERE ended_at IS NULL;
CREATE INDEX user_pauses_user_starts_idx ON user_pauses(user_id, starts_at DESC);
CREATE INDEX user_pauses_expiring_idx ON user_pauses(ends_at) WHERE ended_at IS NULL;

ALTER TABLE users ADD COLUMN actuality_suspended_at timestamptz;

CREATE TABLE actuality_activation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  starts_at timestamptz NOT NULL
);

-- Defaults also cover fixtures and other inserts which bypass the HTTP catalog.
CREATE FUNCTION prepare_listing_actuality() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE planned_start timestamptz;
BEGIN
  IF NEW.status = 'HIDDEN' AND NEW.hidden_reason = 'SPOT_CHECK' THEN
    NEW.spot_check_hold := true;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT a.starts_at INTO planned_start FROM actuality_activation a, platform_settings s
      WHERE a.singleton AND s.key = 'feature_actuality' AND s.value = 'true'::jsonb;
    NEW.lifetime_days := coalesce(NEW.lifetime_days, CASE WHEN NEW.kind = 'BUY' THEN 21 ELSE 14 END);
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
CREATE TRIGGER listings_actuality_shape
  BEFORE INSERT OR UPDATE OF status, lifetime_days ON listings FOR EACH ROW
  EXECUTE FUNCTION prepare_listing_actuality();

CREATE FUNCTION record_listing_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_source text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO listing_price_history (listing_id, changed_at, source, quantity, price, currency)
    VALUES (NEW.id, NEW.created_at, 'CREATE', NEW.quantity, NEW.price, NEW.currency);
  ELSIF (NEW.quantity, NEW.price, NEW.currency) IS DISTINCT FROM (OLD.quantity, OLD.price, OLD.currency) THEN
    change_source := CASE current_setting('hwforai.listing_change_source', true)
      WHEN 'ACTUALITY' THEN 'ACTUALITY' ELSE 'EDIT' END;
    INSERT INTO listing_price_history (listing_id, source, quantity, price, currency)
    VALUES (NEW.id, change_source, NEW.quantity, NEW.price, NEW.currency);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listings_price_history AFTER INSERT OR UPDATE OF quantity, price, currency
  ON listings FOR EACH ROW EXECUTE FUNCTION record_listing_price();
