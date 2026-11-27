ALTER TABLE deals DROP CONSTRAINT deals_disclosure_id_key;
ALTER TABLE deals
  ADD COLUMN chat_id uuid REFERENCES chats(id),
  ADD COLUMN match_id uuid REFERENCES listing_matches(id),
  ADD COLUMN origin text NOT NULL DEFAULT 'FIRST_DISCLOSURE'
    CHECK (origin IN ('FIRST_DISCLOSURE','PAIR_CHAT','MANUAL'));

UPDATE deals d
SET chat_id=s.chat_id, match_id=s.match_id
FROM disclosures s WHERE s.id=d.disclosure_id;

CREATE UNIQUE INDEX deals_chat_unique ON deals(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX deals_disclosure_idx ON deals(disclosure_id);

ALTER TABLE users
  ADD COLUMN trade_sides text[],
  ADD COLUMN onboarding_added_side text CHECK (onboarding_added_side IN ('BUY','SELL'));
UPDATE users SET trade_sides = CASE role WHEN 'SELLER' THEN ARRAY['SELL'] ELSE ARRAY['BUY'] END
WHERE role IN ('SELLER','BUYER');

-- Older seed files, integrations and staff accounts can still omit the new column.
CREATE FUNCTION fill_trade_sides() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IN ('BUYER','SELLER') AND NEW.trade_sides IS NULL AND TG_OP = 'INSERT' THEN
    NEW.trade_sides := ARRAY[CASE WHEN NEW.role='SELLER' THEN 'SELL' ELSE 'BUY' END];
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_trade_sides_default BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION fill_trade_sides();

ALTER TABLE users ADD CONSTRAINT users_trade_sides_shape CHECK (
  (role IN ('BUYER','SELLER') AND trade_sides IS NOT NULL AND
    trade_sides IN (ARRAY['BUY'], ARRAY['SELL'], ARRAY['BUY','SELL']))
  OR (role NOT IN ('BUYER','SELLER') AND trade_sides IS NULL)
);

CREATE OR REPLACE FUNCTION disclosure_open_deal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  seller uuid;
  buyer uuid;
  primary_owner uuid;
  primary_kind text;
  offer uuid;
  request uuid;
BEGIN
  IF NEW.kind <> 'FIRST' OR NEW.migrated OR NOT EXISTS (
    SELECT 1 FROM platform_settings WHERE key='feature_trust_rating' AND value='true'::jsonb
  ) THEN
    RETURN NEW;
  END IF;

  SELECT owner_id, kind INTO primary_owner, primary_kind FROM listings WHERE id=NEW.listing_id;
  IF primary_kind = 'SELL' THEN
    seller := primary_owner;
    buyer := CASE WHEN seller=NEW.user_a_id THEN NEW.user_b_id ELSE NEW.user_a_id END;
    offer := NEW.listing_id;
    SELECT id INTO request FROM listings WHERE id=NEW.counter_listing_id AND kind='BUY' AND owner_id=buyer;
  ELSE
    buyer := primary_owner;
    seller := CASE WHEN buyer=NEW.user_a_id THEN NEW.user_b_id ELSE NEW.user_a_id END;
    request := NEW.listing_id;
    SELECT id INTO offer FROM listings WHERE id=NEW.counter_listing_id AND kind='SELL' AND owner_id=seller;
  END IF;

  INSERT INTO deals(disclosure_id,sell_listing_id,buy_listing_id,seller_id,buyer_id,chat_id,match_id,origin,created_at)
  VALUES(NEW.id,offer,request,seller,buyer,NEW.chat_id,NEW.match_id,'FIRST_DISCLOSURE',NEW.accepted_at)
  ON CONFLICT (chat_id) WHERE chat_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END;
$$;
