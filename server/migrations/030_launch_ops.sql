CREATE TABLE preset_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  preset text NOT NULL CHECK (preset = 'TRIAL'),
  applied_by uuid REFERENCES users(id),
  applied_via text NOT NULL CHECK (applied_via IN ('ADMIN', 'CLI')),
  applied_at timestamptz NOT NULL DEFAULT now(),
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL
);

ALTER TABLE exchange_email_outbox ADD COLUMN error text, ADD COLUMN last_attempt_at timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN last_attempt_at timestamptz;
ALTER TABLE job_runs ADD COLUMN manual_by uuid REFERENCES users(id);
CREATE INDEX job_runs_recent_failure_idx ON job_runs(finished_at DESC) WHERE status='FAILED';

CREATE TABLE ops_job_requests (
  job text PRIMARY KEY,
  requested_at timestamptz NOT NULL
);

CREATE TABLE ops_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_test_mail_at timestamptz,
  test_mail_ok boolean,
  last_backup_at timestamptz,
  last_backup_ok boolean,
  last_backup_report_at timestamptz,
  last_restore_at timestamptz,
  last_restore_ok boolean,
  last_restore_report_at timestamptz,
  disk_free_percent numeric(5,2) CHECK (disk_free_percent BETWEEN 0 AND 100),
  disk_checked_at timestamptz,
  backup_bytes bigint CHECK (backup_bytes >= 0)
);
INSERT INTO ops_status (singleton) VALUES (true);

CREATE TABLE scheduled_rules (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version text NOT NULL,
  translations jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  scheduled_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value) VALUES ('ops_alerts', '{"failedJobs":true,"failedEmailsPerHour":5}');

INSERT INTO site_content (key, translations, active) VALUES ('rules_draft', jsonb_build_object('ru',
  jsonb_build_object('title', 'Заготовка правил площадки', 'body', $rules$
Правила площадки [НАЗВАНИЕ ПЛОЩАДКИ]
Версия [ВЕРСИЯ] от [ДАТА]. Оператор: [ЮРЛИЦО ПЛОЩАДКИ], [АДРЕС], [КОНТАКТ].

1. Участник выступает прямой стороной сделки или агентом с прямым доступом к стороне. Цепочки посредников запрещены.
2. В карточках и документах указываются достоверные сведения. Подделка документов или фото влечёт бессрочную блокировку.
3. Контакты, раскрытые площадкой, используются для переговоров по позиции. Передача третьим лицам запрещена.
4. Сделка по той же или аналогичной позиции в течение 12 месяцев после раскрытия считается сведённой площадкой. Если стороны были знакомы раньше, зафиксируйте это кнопкой «Уже знакомы» в течение 24 часов.
5. Подтверждайте актуальность объявления каждый день или устанавливайте паузу до пяти дней в месяц. После 24 часов без ответа объявление скрывается. После трёх пропусков за 30 дней скрываются все объявления участника до ответа.
6. При споре стороны передают переписку и материалы по сделке. Порядок опубликован в разделе «Споры». Отказ предоставить запрошенные материалы учитывается при решении.
7. Пропуски подтверждения влияют на рейтинг. Доказанное несоответствие цены или количества может повлечь скрытие объявления и снижение рейтинга на 10 баллов. Скрытая наценка агента может повлечь снятие отметки на 90 дней. Обход правил раскрытия может повлечь блокировку.
8. Оператор может участвовать в сделках на общих условиях. В рамках жалобы или спора доступ сотрудников к переписке фиксируется в журнале.
9. Площадка помогает найти контрагента. Площадка не держит деньги участников, не проверяет товар и не выступает стороной сделки.
10. Об изменении правил площадка уведомляет минимум за семь дней. Версия правил, действовавшая на момент раскрытия, фиксируется в журнале.
11. Обработка персональных данных описана в политике [ССЫЛКА].
$rules$)), false) ON CONFLICT (key) DO NOTHING;

CREATE TABLE readiness_attestations (
  key text PRIMARY KEY CHECK (key IN ('mailboxes','monitor','invitations','email')),
  checked boolean NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
