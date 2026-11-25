CREATE TABLE disclosures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_a_id uuid NOT NULL REFERENCES users(id),
  user_b_id uuid NOT NULL REFERENCES users(id),
  exchange_id bigint NOT NULL UNIQUE REFERENCES chat_contact_exchanges(id),
  chat_id uuid NOT NULL REFERENCES chats(id),
  listing_id uuid NOT NULL REFERENCES listings(id),
  counter_listing_id uuid REFERENCES listings(id),
  match_id uuid,
  kind text NOT NULL CHECK (kind IN ('FIRST', 'REPEAT')),
  requested_by uuid NOT NULL REFERENCES users(id),
  accepted_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz,
  accepted_at timestamptz NOT NULL,
  rules_version text,
  listing_snapshot jsonb NOT NULL,
  counter_listing_snapshot jsonb,
  party_a jsonb NOT NULL,
  party_b jsonb NOT NULL,
  migrated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a_id < user_b_id),
  CHECK (requested_by IN (user_a_id, user_b_id) AND accepted_by IN (user_a_id, user_b_id) AND requested_by <> accepted_by)
);
CREATE INDEX disclosures_pair_idx ON disclosures(user_a_id, user_b_id, accepted_at DESC, number DESC);
CREATE INDEX disclosures_user_a_idx ON disclosures(user_a_id, accepted_at DESC);
CREATE INDEX disclosures_user_b_idx ON disclosures(user_b_id, accepted_at DESC);

CREATE TABLE disclosure_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  disclosure_id uuid NOT NULL REFERENCES disclosures(id),
  actor_user_id uuid REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('ALREADY_KNOWN', 'DEAL_STATUS', 'DEAL_VERIFIED', 'ADMIN_NOTE')),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disclosure_events_idx ON disclosure_events(disclosure_id, id);
CREATE UNIQUE INDEX disclosure_already_known_unique ON disclosure_events(disclosure_id, actor_user_id)
  WHERE type = 'ALREADY_KNOWN';

ALTER TABLE telegram_consents ADD COLUMN requested_at timestamptz;
ALTER TABLE telegram_consents ADD COLUMN requested_rules_version text;

-- Only deliberately selected commercial fields are copied into the immutable journal.
CREATE FUNCTION disclosure_listing_snapshot(l listings) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', l.id, 'title', l.title, 'kind', l.kind, 'description', l.description, 'categoryId', l.category_id,
    'quantity', l.quantity, 'condition', l.condition, 'priceMode', l.price_mode, 'price', l.price,
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

-- Current handles must never be substituted for a historical consent on another version.
CREATE FUNCTION disclosure_party_snapshot(u users, consent_version bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'userId', u.id, 'nickname', u.display_name, 'participantType', u.participant_type, 'companyName', u.company_name,
    'country', u.country, 'city', u.city, 'role', u.role,
    'representation', CASE WHEN EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_representation' AND value = 'true'::jsonb)
      THEN to_jsonb(u)->>'representation_mode' END,
    'level', CASE WHEN EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_trust_rating' AND value = 'true'::jsonb)
      THEN to_jsonb(u)->'verification_level' END,
    'telegram', CASE WHEN u.telegram_version = consent_version THEN u.telegram
      ELSE (SELECT h.previous_handle FROM telegram_handle_history h
        WHERE h.user_id = u.id AND h.version = consent_version + 1) END
  )
$$;

WITH historical AS (
  SELECT e.*, least(e.requested_by, e.accepted_by) AS pair_a_id, greatest(e.requested_by, e.accepted_by) AS pair_b_id,
    row_number() OVER (PARTITION BY least(e.requested_by, e.accepted_by), greatest(e.requested_by, e.accepted_by)
      ORDER BY e.accepted_at, e.id) AS ordinal
  FROM chat_contact_exchanges e
)
INSERT INTO disclosures (
  user_a_id, user_b_id, exchange_id, chat_id, listing_id, kind, requested_by, accepted_by, accepted_at,
  listing_snapshot, party_a, party_b, migrated
)
SELECT h.pair_a_id, h.pair_b_id, h.id, h.chat_id, l.id, CASE WHEN h.ordinal = 1 THEN 'FIRST' ELSE 'REPEAT' END,
  h.requested_by, h.accepted_by, h.accepted_at, disclosure_listing_snapshot(l),
  disclosure_party_snapshot(a, h.a_version), disclosure_party_snapshot(b, h.b_version), true
FROM historical h
JOIN chats c ON c.id = h.chat_id JOIN listings l ON l.id = c.listing_id
JOIN users a ON a.id = h.pair_a_id JOIN users b ON b.id = h.pair_b_id
ORDER BY h.accepted_at, h.id;

INSERT INTO job_runs (job, slot, status, finished_at, stats)
SELECT 'disclosure.alias-audit', 'migration-013', 'DONE', now(), jsonb_build_object('matches', count(*))
FROM users u
CROSS JOIN LATERAL (
  SELECT ARRAY(SELECT word FROM unnest(market_search_words(u.company_name)) AS word WHERE length(word) >= 4) AS words
) company
WHERE cardinality(company.words) > 0 AND
  (company.words <@ market_search_words(u.username) OR company.words <@ market_search_words(u.display_name));

CREATE FUNCTION reject_disclosure_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Запись журнала раскрытий не изменяется и не удаляется';
END
$$;
CREATE TRIGGER disclosures_immutable BEFORE UPDATE OR DELETE ON disclosures
  FOR EACH ROW EXECUTE FUNCTION reject_disclosure_mutation();
CREATE TRIGGER disclosure_events_immutable BEFORE UPDATE OR DELETE ON disclosure_events
  FOR EACH ROW EXECUTE FUNCTION reject_disclosure_mutation();
