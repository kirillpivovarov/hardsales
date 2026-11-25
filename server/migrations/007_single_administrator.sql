DO $$
BEGIN
  IF (SELECT count(*) FROM users WHERE role = 'ADMIN') > 1 THEN
    RAISE EXCEPTION 'Multiple administrator accounts found. Resolve the duplicate administrator roles before applying migration 007.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX users_one_administrator ON users (role) WHERE role = 'ADMIN';

-- Keep moderation attributable when the administrator changes their login.
-- Earlier records have no verified stable actor identifier.
ALTER TABLE moderation_audit ADD COLUMN actor_user_id uuid;
