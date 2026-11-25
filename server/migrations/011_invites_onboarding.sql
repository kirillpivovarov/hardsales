CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  preset_role text CHECK (preset_role IN ('BUYER', 'SELLER')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  used_by uuid UNIQUE REFERENCES users(id),
  used_at timestamptz,
  CHECK ((used_by IS NULL) = (used_at IS NULL)),
  CHECK (expires_at > created_at)
);

CREATE INDEX invites_open_idx ON invites(created_at DESC) WHERE used_by IS NULL AND revoked_at IS NULL;

ALTER TABLE users
  ADD COLUMN invite_id uuid REFERENCES invites(id),
  ADD COLUMN representation_mode text NOT NULL DEFAULT 'DIRECT'
    CHECK (representation_mode IN ('DIRECT', 'AGENT', 'BOTH')),
  ADD COLUMN onboarding_state text NOT NULL DEFAULT 'EXEMPT'
    CHECK (onboarding_state IN ('REQUIRED', 'DONE', 'EXEMPT')),
  ADD COLUMN onboarding_answers jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN onboarding_submitted_at timestamptz,
  ADD COLUMN rules_accepted_version text,
  ADD COLUMN rules_accepted_at timestamptz;
