-- Replace the shape check from 002. Existing SELL rows with a NULL scope
-- and a concrete country remain valid.
ALTER TABLE listings
  DROP CONSTRAINT listings_check1,
  ADD CONSTRAINT listings_shipping_shape_check CHECK (
    (kind = 'SELL' AND availability IS NOT NULL AND condition != 'ANY'
      AND (availability != 'STOCK' OR stock_city IS NOT NULL)
      AND (
        (origin_scope IS NOT DISTINCT FROM 'ANY' AND origin_country IS NULL)
        OR (coalesce(origin_scope, 'COUNTRY') = 'COUNTRY' AND origin_country IS NOT NULL)
      )) OR
    (kind = 'BUY' AND availability IS NULL AND origin_scope IS NOT NULL AND destination_country IS NOT NULL
      AND delivery_by IS NOT NULL AND (origin_scope = 'ANY' OR origin_country IS NOT NULL))
  );
