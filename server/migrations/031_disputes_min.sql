CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  disclosure_id uuid NOT NULL REFERENCES disclosures(id),
  deal_id uuid REFERENCES deals(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  against uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('MISREPRESENTATION','HIDDEN_MARKUP','NO_CORRESPONDENCE','BYPASS','FORGERY','OTHER')),
  essence text NOT NULL CHECK (length(essence) BETWEEN 20 AND 4000),
  demand text NOT NULL CHECK (length(demand) BETWEEN 5 AND 1000),
  status text NOT NULL DEFAULT 'OPENED' CHECK (status IN ('OPENED','AWAITING_MATERIALS','REVIEW','DECIDED','REOPENED','CLOSED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  notify_by timestamptz NOT NULL,
  notified_at timestamptz,
  materials_by timestamptz,
  review_started_at timestamptz,
  decision_by timestamptz,
  review_until timestamptz,
  position text CHECK (length(position) BETWEEN 1 AND 4000),
  position_at timestamptz,
  assigned_to uuid REFERENCES users(id),
  CHECK (opened_by <> against)
);
CREATE INDEX disputes_open_idx ON disputes(status, opened_at) WHERE status NOT IN ('DECIDED','CLOSED');
CREATE INDEX disputes_parties_idx ON disputes(opened_by,against,opened_at DESC);
CREATE UNIQUE INDEX disputes_one_open ON disputes(disclosure_id, opened_by) WHERE status NOT IN ('DECIDED','CLOSED');

CREATE TABLE dispute_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  from_user uuid NOT NULL REFERENCES users(id),
  to_user uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  round smallint NOT NULL CHECK (round IN (1,2)),
  reply_to bigint REFERENCES dispute_messages(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_messages_idx ON dispute_messages(dispute_id, id);

CREATE TABLE dispute_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  user_id uuid NOT NULL REFERENCES users(id),
  round smallint NOT NULL DEFAULT 1 CHECK (round IN (1,2)),
  question_id bigint REFERENCES dispute_messages(id),
  note text CHECK (length(note) BETWEEN 1 AND 2000),
  file_name text CHECK (length(file_name) BETWEEN 1 AND 200),
  mime_type text CHECK (mime_type IN ('application/pdf','image/jpeg','image/png','image/webp','text/plain')),
  content bytea CHECK (octet_length(content) BETWEEN 1 AND 10485760),
  sha256 char(64),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (note IS NOT NULL OR content IS NOT NULL),
  CHECK ((content IS NULL) = (file_name IS NULL) AND (file_name IS NULL) = (mime_type IS NULL))
);
CREATE INDEX dispute_materials_idx ON dispute_materials(dispute_id,uploaded_at);

CREATE TABLE dispute_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  round smallint NOT NULL CHECK (round IN (1,2)),
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  loser_id uuid REFERENCES users(id),
  penalty text NOT NULL CHECK (penalty IN ('NONE','MISREPRESENTATION','HIDDEN_MARKUP','NO_CORRESPONDENCE','LOST','BYPASS','FORGERY')),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 20 AND 4000),
  listing_id uuid REFERENCES listings(id),
  same_reviewer boolean NOT NULL DEFAULT false,
  effects jsonb NOT NULL DEFAULT '{}',
  UNIQUE (dispute_id, round),
  CHECK ((penalty = 'NONE') = (loser_id IS NULL))
);
CREATE INDEX dispute_decisions_loser_idx ON dispute_decisions(loser_id,decided_at) WHERE loser_id IS NOT NULL;
CREATE TRIGGER dispute_decisions_immutable BEFORE UPDATE OR DELETE ON dispute_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_disclosure_mutation();

CREATE TABLE dispute_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  user_id uuid NOT NULL REFERENCES users(id),
  text text NOT NULL CHECK (length(text) BETWEEN 20 AND 4000),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispute_id,user_id)
);

ALTER TABLE disclosure_events DROP CONSTRAINT disclosure_events_type_check;
ALTER TABLE disclosure_events ADD CONSTRAINT disclosure_events_type_check
  CHECK (type IN ('ALREADY_KNOWN','DEAL_STATUS','DEAL_VERIFIED','ADMIN_NOTE','DISPUTE'));
ALTER TABLE user_penalties DROP CONSTRAINT user_penalties_kind_check;
ALTER TABLE user_penalties ADD CONSTRAINT user_penalties_kind_check
  CHECK (kind IN ('DAY_CODE_SPOT_CHECK_FAILED','MISREPRESENTATION_PROVEN','OTHER','DISPUTE'));
ALTER TABLE user_penalties ADD COLUMN dispute_id uuid REFERENCES disputes(id);
CREATE UNIQUE INDEX user_penalties_one_dispute ON user_penalties(dispute_id) WHERE dispute_id IS NOT NULL;

INSERT INTO platform_settings (key,value) VALUES ('feature_disputes','false');

INSERT INTO site_content (key,translations) VALUES ('disputes', jsonb_build_object('ru',jsonb_build_object(
  'title','Порядок рассмотрения споров',
  'body',$page$Открыть спор может любая сторона записи о раскрытии контактов. В журнале раскрытий выберите запись и опишите, что случилось и какого результата вы ожидаете. При необходимости укажите сделку.

Площадка уведомит вторую сторону в течение одного рабочего дня. У обеих сторон будет три рабочих дня, чтобы приложить переписку и документы. Сотрудник может запросить уточнения.

Сотрудник рассматривает материалы и публикует обоснованное решение в течение пяти рабочих дней после начала разбора. Стороны получают уведомление. При подтверждённом нарушении площадка применяет меры, предусмотренные правилами.

В течение семи суток после первого решения каждая сторона может один раз подать новые доводы. При возможности спор пересматривает другой сотрудник. Второе решение окончательное.

Материалы доступны сторонам и сотрудникам площадки. Вопрос сотрудника и ответ на него видит адресат. Рабочими днями считаются понедельник–пятница по часовому поясу площадки.$page$
))) ON CONFLICT (key) DO NOTHING;
