ALTER TABLE users
  ADD COLUMN telegram_verified_at timestamptz,
  ADD COLUMN telegram_verified_version bigint,
  ADD CONSTRAINT users_telegram_verified_pair
    CHECK ((telegram_verified_at IS NULL) = (telegram_verified_version IS NULL));

INSERT INTO platform_settings (key, value) VALUES ('disclosure_requires_verified_telegram', 'false');

CREATE FUNCTION clear_telegram_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF lower(OLD.telegram) IS DISTINCT FROM lower(NEW.telegram)
      OR OLD.telegram_chat_id IS DISTINCT FROM NEW.telegram_chat_id
      OR OLD.telegram_user_id IS DISTINCT FROM NEW.telegram_user_id THEN
    NEW.telegram_verified_at := NULL;
    NEW.telegram_verified_version := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_telegram_clear_verification
  BEFORE UPDATE OF telegram, telegram_chat_id, telegram_user_id ON users
  FOR EACH ROW EXECUTE FUNCTION clear_telegram_verification();

CREATE FUNCTION telegram_handle_verified(u users) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT u.telegram_chat_id IS NOT NULL AND u.telegram_verified_at IS NOT NULL
    AND u.telegram_verified_version IS NOT DISTINCT FROM u.telegram_version
$$;

-- The snapshot is immutable. Existing disclosures keep the evidence recorded at their original date.
CREATE OR REPLACE FUNCTION disclosure_party_snapshot(u users, consent_version bigint)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'userId', u.id, 'nickname', u.display_name, 'participantType', u.participant_type, 'companyName', u.company_name,
    'country', u.country, 'city', u.city, 'role', u.role,
    'representation', CASE WHEN EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_representation' AND value = 'true'::jsonb)
      THEN to_jsonb(u)->>'representation_mode' END,
    'level', CASE WHEN EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_trust_rating' AND value = 'true'::jsonb)
      THEN to_jsonb(u)->'verification_level' END,
    'telegram', CASE WHEN u.telegram_version = consent_version THEN u.telegram
      ELSE (SELECT h.previous_handle FROM telegram_handle_history h
        WHERE h.user_id = u.id AND h.version = consent_version + 1) END,
    'telegramVerified', u.telegram_version IS NOT DISTINCT FROM consent_version AND telegram_handle_verified(u)
      AND EXISTS (SELECT 1 FROM platform_settings WHERE key = 'feature_telegram' AND value = 'true'::jsonb)
  )
$$;
