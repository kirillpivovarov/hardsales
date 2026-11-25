CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  display_name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('BUYER', 'SELLER', 'ADMIN')),
  participant_type text CHECK (participant_type IN ('INDIVIDUAL', 'COMPANY')),
  company_name text,
  city text,
  country text CHECK (country ~ '^[A-Z]{2}$'),
  telegram text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'BANNED')),
  email_verified_at timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  credential_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_market_profile CHECK (
    role = 'ADMIN' OR (
      participant_type IS NOT NULL AND city IS NOT NULL AND country IS NOT NULL AND telegram IS NOT NULL
      AND (participant_type <> 'COMPANY' OR company_name IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX users_username_unique ON users (lower(username));
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE auth_sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE email_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('REGISTER', 'LOGIN')),
  email text NOT NULL,
  code_hash char(64) NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  pending_registration jsonb,
  credential_version integer,
  expires_at timestamptz NOT NULL,
  resend_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  delivered_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_challenges_subject CHECK (
    (purpose = 'REGISTER' AND pending_registration IS NOT NULL AND user_id IS NULL AND credential_version IS NULL)
    OR (purpose = 'LOGIN' AND pending_registration IS NULL AND user_id IS NOT NULL AND credential_version IS NOT NULL)
  )
);
CREATE INDEX email_challenges_email ON email_challenges(email);
CREATE INDEX email_challenges_expiry ON email_challenges(expires_at);

CREATE TABLE auth_rate_limits (
  bucket text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);
