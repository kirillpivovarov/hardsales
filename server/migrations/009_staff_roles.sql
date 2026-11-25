ALTER TABLE users
  DROP CONSTRAINT users_role_check,
  DROP CONSTRAINT users_market_profile,
  ADD CONSTRAINT users_role_check CHECK (role IN ('BUYER', 'SELLER', 'ADMIN', 'MODERATOR')),
  ADD CONSTRAINT users_market_profile CHECK (
    role IN ('ADMIN', 'MODERATOR') OR (
      participant_type IS NOT NULL AND city IS NOT NULL AND country IS NOT NULL AND telegram IS NOT NULL
      AND (participant_type <> 'COMPANY' OR company_name IS NOT NULL)
    )
  );

ALTER TABLE moderation_audit
  ADD COLUMN actor_role text CHECK (actor_role IN ('ADMIN', 'MODERATOR', 'AGENT'));

-- Existing stable human identifiers can only belong to the sole administrator.
UPDATE moderation_audit SET actor_role = 'ADMIN' WHERE actor_user_id IS NOT NULL;
UPDATE moderation_audit SET actor_role = 'AGENT'
  WHERE actor_user_id IS NULL AND actor = 'agent:moderation';
