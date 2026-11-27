-- Fixed prices used to store the total. The canonical demo listings were
-- already priced per unit and keep their original values.
CREATE TEMP TABLE unit_price_demo_seed (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO unit_price_demo_seed (id) VALUES
  ('00000000-0000-4000-8110-000000000001'), ('00000000-0000-4000-8110-000000000002'),
  ('00000000-0000-4000-8110-000000000003'), ('00000000-0000-4000-8110-000000000004'),
  ('00000000-0000-4000-8110-000000000005'), ('00000000-0000-4000-8110-000000000006'),
  ('00000000-0000-4000-8110-000000000007'), ('00000000-0000-4000-8110-000000000008'),
  ('00000000-0000-4000-8110-000000000011'), ('00000000-0000-4000-8110-000000000012'),
  ('00000000-0000-4000-8110-000000000013'), ('00000000-0000-4000-8110-000000000014');

UPDATE listing_price_history history
SET price = greatest(0.01, round(history.price / history.quantity, 2))
WHERE history.price IS NOT NULL AND history.quantity > 1
  AND NOT EXISTS (SELECT 1 FROM unit_price_demo_seed seed WHERE seed.id = history.listing_id);

-- Preserve the number, timestamps and sources of genuine historical changes.
ALTER TABLE listings DISABLE TRIGGER listings_price_history;
WITH converted AS (
  UPDATE listings listing
  SET price = greatest(0.01, round(listing.price / listing.quantity, 2))
  WHERE listing.price_mode = 'FIXED' AND listing.quantity > 1 AND listing.price IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM unit_price_demo_seed seed WHERE seed.id = listing.id)
  RETURNING owner_id
)
INSERT INTO notifications(user_id, kind, title, body, actions, dedupe_key)
SELECT DISTINCT owner_id, 'listing.price_unit', 'Цены теперь указываются за одну штуку',
  'Мы пересчитали цены ваших объявлений. Проверьте их в разделе «Мои объявления».',
  '[{"label":"Мои объявления","href":"/my-listings"}]'::jsonb, 'listing.price_unit:v3'
FROM converted
ON CONFLICT DO NOTHING;
ALTER TABLE listings ENABLE TRIGGER listings_price_history;

-- Accommodates the product of any previously stored price and FX rate.
ALTER TABLE listings ADD COLUMN price_usd numeric(26, 2);
UPDATE listings listing SET price_usd = round(listing.price * rate.usd_per_unit, 2)
FROM fx_rates rate WHERE listing.currency = rate.currency AND listing.price_mode = 'FIXED';

CREATE INDEX listings_public_price_usd_idx ON listings(kind, price_usd, created_at DESC, id)
WHERE status = 'ACTIVE' AND price_usd IS NOT NULL;

-- A rate change serializes with listing price writes, including new rows
-- and rows entering the changed currency during a rate calculation.
CREATE FUNCTION lock_listing_price_writes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(18403, 32);
  RETURN NULL;
END;
$$;
CREATE TRIGGER listings_price_write_lock
BEFORE INSERT OR UPDATE OF price, currency, price_mode ON listings
FOR EACH STATEMENT EXECUTE FUNCTION lock_listing_price_writes();

CREATE FUNCTION prepare_listing_price_usd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.price_usd := CASE WHEN NEW.price_mode = 'FIXED'
    THEN (SELECT round(NEW.price * r.usd_per_unit, 2) FROM fx_rates r WHERE r.currency = NEW.currency)
    ELSE NULL END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listings_prepare_price_usd
BEFORE INSERT OR UPDATE OF price, currency, price_mode ON listings
FOR EACH ROW EXECUTE FUNCTION prepare_listing_price_usd();

INSERT INTO platform_settings (key, value) VALUES ('model_required_categories', '["gpu","servers"]');

CREATE FUNCTION listing_model_required(category_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE parents AS (
    SELECT id, slug, parent_id FROM categories WHERE id = category_id
    UNION ALL SELECT c.id, c.slug, c.parent_id FROM categories c JOIN parents p ON c.id = p.parent_id
  )
  SELECT EXISTS (
    SELECT 1 FROM parents p JOIN platform_settings s ON s.key = 'model_required_categories' AND s.value ? p.slug
  );
$$;

-- Accept Cyrillic Л40С and the shortened Dell family label R760 in
-- catalog text searches, including legacy listings without a model ID.
CREATE OR REPLACE FUNCTION market_search_document(words text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT words || ARRAY(
    SELECT DISTINCT alias
    FROM unnest(words) AS word
    CROSS JOIN LATERAL (
      VALUES
        (substring(word FROM '^(?:rtx|gtx|rx)([0-9]{4})(?:ti|super|xt|xtx)?$')),
        (CASE WHEN word ~ '^(rtx(?:20|30|40|50)|gtx(?:10|16))[0-9]{2}(?:ti|super)?$' THEN 'geforce' END),
        (CASE WHEN word ~ '^sxm[0-9]+$' THEN 'sxm' END),
        (CASE WHEN word = 'l40s' THEN 'l40c' END),
        (CASE WHEN word = 'r760xa' THEN 'r760' END)
    ) AS aliases(alias)
    WHERE alias IS NOT NULL
  )
$$;

UPDATE listings SET title = title WHERE search_words && ARRAY['r760xa','l40s']::text[];

-- Keep old disclosure snapshots immutable. New snapshots identify their unit.
CREATE OR REPLACE FUNCTION disclosure_listing_snapshot(l listings) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', l.id, 'title', l.title, 'kind', l.kind, 'description', l.description, 'categoryId', l.category_id,
    'quantity', l.quantity, 'condition', l.condition, 'priceMode', l.price_mode, 'price', l.price,
    'priceBasis', 'UNIT', 'totalPrice', l.price * l.quantity,
    'currency', l.currency, 'availability', l.availability, 'originScope', l.origin_scope,
    'originCountry', l.origin_country, 'destinationCountry', l.destination_country, 'stockCity', l.stock_city,
    'deliveryBy', l.delivery_by, 'deliveryIncluded', l.delivery_included, 'customsIncluded', l.customs_included,
    'vat', l.vat, 'counterparty', l.counterparty, 'paymentMethods', l.payment_methods, 'specs', l.specs,
    'minLot', to_jsonb(l)->'min_lot', 'shipDays', to_jsonb(l)->'ship_days',
    'paymentTerms', to_jsonb(l)->'payment_terms', 'modelId', to_jsonb(l)->'model_id',
    'representation', CASE WHEN EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_representation' AND value = 'true'::jsonb)
      THEN to_jsonb(l)->>'representation' END,
    'imageIds', coalesce((SELECT jsonb_agg(i.id ORDER BY i.position) FROM listing_images i WHERE i.listing_id = l.id), '[]'::jsonb),
    'snapshotAt', now()
  )
$$;
