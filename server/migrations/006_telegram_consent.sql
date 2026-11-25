CREATE TABLE telegram_handle_history (
  user_id uuid NOT NULL REFERENCES users(id),
  version bigint NOT NULL CHECK (version > 0),
  previous_handle text,
  new_handle text,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, version),
  CHECK (lower(previous_handle) IS DISTINCT FROM lower(new_handle))
);

CREATE OR REPLACE FUNCTION bump_telegram_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF lower(OLD.telegram) IS DISTINCT FROM lower(NEW.telegram) THEN
    NEW.telegram_version := OLD.telegram_version + 1;
    INSERT INTO telegram_handle_history(user_id, version, previous_handle, new_handle)
    VALUES (OLD.id, NEW.telegram_version, OLD.telegram, NEW.telegram);
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE telegram_consents (
  user_a_id uuid NOT NULL REFERENCES users(id),
  user_b_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'NONE' CHECK (state IN ('NONE', 'REQUESTED', 'ACCEPTED', 'DECLINED')),
  requested_by uuid REFERENCES users(id),
  request_id uuid UNIQUE,
  a_version bigint,
  b_version bigint,
  last_accepted_at timestamptz,
  last_accepted_a_version bigint,
  last_accepted_b_version bigint,
  PRIMARY KEY (user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id),
  CHECK (requested_by IS NULL OR requested_by IN (user_a_id, user_b_id)),
  CHECK (
    (state = 'NONE' AND num_nonnulls(requested_by, request_id, a_version, b_version) = 0) OR
    (state <> 'NONE' AND num_nonnulls(requested_by, request_id, a_version, b_version) = 4)
  ),
  CHECK ((last_accepted_a_version IS NULL) = (last_accepted_b_version IS NULL)),
  CHECK (last_accepted_at IS NOT NULL OR last_accepted_a_version IS NULL)
);

ALTER TABLE chat_contact_exchanges
  ADD COLUMN a_version bigint,
  ADD COLUMN b_version bigint,
  ADD CONSTRAINT chat_contact_exchange_versions_both CHECK ((a_version IS NULL) = (b_version IS NULL));

-- Only the final acceptance in a chat still marked accepted has a recoverable version snapshot.
WITH last_in_chat AS (
  SELECT DISTINCT ON (chat_id) id, chat_id
  FROM chat_contact_exchanges
  ORDER BY chat_id, id DESC
)
UPDATE chat_contact_exchanges e SET
  a_version = CASE WHEN c.owner_id < c.visitor_id THEN c.owner_telegram_version ELSE c.visitor_telegram_version END,
  b_version = CASE WHEN c.owner_id < c.visitor_id THEN c.visitor_telegram_version ELSE c.owner_telegram_version END
FROM last_in_chat x JOIN chats c ON c.id = x.chat_id
WHERE e.id = x.id AND c.reveal_state = 'ACCEPTED';

-- Keep current mutual consent ahead of pending requests. Old requests carry no timestamp of their own.
WITH current_exchange AS (
  SELECT DISTINCT ON (user_a_id, user_b_id)
    least(c.owner_id, c.visitor_id) AS user_a_id,
    greatest(c.owner_id, c.visitor_id) AS user_b_id,
    c.reveal_state, c.reveal_requested_by,
    CASE WHEN c.owner_id < c.visitor_id THEN c.owner_telegram_version ELSE c.visitor_telegram_version END AS a_version,
    CASE WHEN c.owner_id < c.visitor_id THEN c.visitor_telegram_version ELSE c.owner_telegram_version END AS b_version
  FROM chats c
  JOIN users owner ON c.owner_id = owner.id
  JOIN users visitor ON c.visitor_id = visitor.id
  JOIN listings l ON l.id = c.listing_id
  WHERE c.owner_telegram_version = owner.telegram_version
    AND c.visitor_telegram_version = visitor.telegram_version
    AND c.reveal_requested_by IS NOT NULL
    AND (c.reveal_state = 'ACCEPTED' OR (
      c.reveal_state = 'REQUESTED' AND l.status NOT IN ('FROZEN', 'BANNED')
      AND owner.status = 'ACTIVE' AND visitor.status = 'ACTIVE'
      AND owner.email_verified_at IS NOT NULL AND visitor.email_verified_at IS NOT NULL
    ))
  ORDER BY user_a_id, user_b_id, (c.reveal_state = 'ACCEPTED') DESC, c.created_at DESC, c.id
), last_accepted AS (
  SELECT DISTINCT ON (user_a_id, user_b_id)
    least(requested_by, accepted_by) AS user_a_id,
    greatest(requested_by, accepted_by) AS user_b_id,
    accepted_at, a_version, b_version
  FROM chat_contact_exchanges
  ORDER BY user_a_id, user_b_id, id DESC
)
INSERT INTO telegram_consents (
  user_a_id, user_b_id, state, requested_by, request_id, a_version, b_version,
  last_accepted_at, last_accepted_a_version, last_accepted_b_version
)
SELECT
  coalesce(c.user_a_id, e.user_a_id), coalesce(c.user_b_id, e.user_b_id),
  coalesce(c.reveal_state, 'NONE'), c.reveal_requested_by,
  CASE WHEN c.reveal_state IS NOT NULL THEN gen_random_uuid() END,
  c.a_version, c.b_version, e.accepted_at,
  CASE WHEN c.reveal_state = 'ACCEPTED' THEN c.a_version ELSE e.a_version END,
  CASE WHEN c.reveal_state = 'ACCEPTED' THEN c.b_version ELSE e.b_version END
FROM current_exchange c FULL JOIN last_accepted e USING (user_a_id, user_b_id);

ALTER TABLE chats
  DROP COLUMN reveal_state,
  DROP COLUMN reveal_requested_by,
  DROP COLUMN owner_telegram_version,
  DROP COLUMN visitor_telegram_version;

UPDATE site_content SET translations = jsonb_set(translations, '{ru,body}', to_jsonb(
  'Другие участники видят ваш публичный ник, город, страну, тип участника и репутацию. Email используется для подтверждения аккаунта. Привязанные контакты Telegram становятся доступны после взаимного согласия во всех доступных чатах той же пары участников. Если кто-то меняет ник Telegram, для его раскрытия нужно новое согласие. Площадка хранит историю изменений, а собеседник видит уведомление об изменении без прежнего и нового ника.'::text
)), updated_at = now()
WHERE key = 'privacy' AND translations #>> '{ru,body}' =
  'Другие участники видят ваш публичный ник, город, страну, тип участника и репутацию. Email используется для подтверждения аккаунта. Привязанный Telegram доступен собеседнику после взаимного согласия.';
