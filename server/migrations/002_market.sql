CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,47}$'),
  name text NOT NULL,
  short_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT 'components',
  parent_id uuid REFERENCES categories(id),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  attribute_keys text[] NOT NULL DEFAULT '{}',
  translations jsonb NOT NULL DEFAULT '{}',
  CHECK (parent_id IS DISTINCT FROM id)
);

CREATE TABLE listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  kind text NOT NULL CHECK (kind IN ('SELL', 'BUY')),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  description text NOT NULL CHECK (length(description) BETWEEN 10 AND 8000),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  condition text NOT NULL CHECK (condition IN ('NEW', 'USED', 'REFURBISHED', 'ANY')),
  price_mode text NOT NULL CHECK (price_mode IN ('FIXED', 'NEGOTIABLE')),
  price numeric(15, 2) CHECK (price > 0),
  currency text NOT NULL CHECK (currency IN ('RUB', 'USD', 'EUR', 'CNY', 'KZT', 'AED')),
  availability text CHECK (availability IN ('STOCK', 'TRANSIT', 'ORDER')),
  origin_scope text CHECK (origin_scope IN ('DOMESTIC', 'ANY', 'COUNTRY')),
  origin_country text CHECK (origin_country ~ '^[A-Z]{2}$'),
  destination_country text CHECK (destination_country ~ '^[A-Z]{2}$'),
  stock_city text,
  delivery_by date,
  delivery_included boolean NOT NULL DEFAULT false,
  customs_included boolean NOT NULL DEFAULT false,
  vat text NOT NULL CHECK (vat IN ('INCLUDED', 'EXCLUDED', 'NA')),
  counterparty text NOT NULL CHECK (counterparty IN ('COMPANY', 'ANY')),
  payment_methods text[] NOT NULL DEFAULT '{}',
  specs jsonb NOT NULL DEFAULT '{}',
  image_key text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'BANNED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((price_mode = 'FIXED' AND price IS NOT NULL) OR (price_mode = 'NEGOTIABLE' AND price IS NULL)),
  CHECK (
    (kind = 'SELL' AND availability IS NOT NULL AND origin_country IS NOT NULL AND origin_scope IS NULL
      AND (availability != 'STOCK' OR stock_city IS NOT NULL) AND condition != 'ANY') OR
    (kind = 'BUY' AND availability IS NULL AND origin_scope IS NOT NULL AND destination_country IS NOT NULL
      AND delivery_by IS NOT NULL AND (origin_scope = 'ANY' OR origin_country IS NOT NULL))
  )
);
CREATE INDEX listings_public_newest_idx ON listings(kind, created_at DESC, id) WHERE status = 'ACTIVE';
CREATE INDEX listings_public_facets_idx ON listings(kind, category_id, origin_country, destination_country, availability) WHERE status = 'ACTIVE';
CREATE INDEX listings_price_idx ON listings(kind, currency, price) WHERE status = 'ACTIVE';
CREATE INDEX listings_owner_idx ON listings(owner_id, created_at DESC);

-- Bump the consent version even if a user changes a handle and later switches back.
ALTER TABLE users ADD COLUMN telegram_version bigint NOT NULL DEFAULT 0;
CREATE FUNCTION bump_telegram_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.telegram_version := OLD.telegram_version + 1;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_telegram_version BEFORE UPDATE OF telegram ON users
FOR EACH ROW WHEN (OLD.telegram IS DISTINCT FROM NEW.telegram) EXECUTE FUNCTION bump_telegram_version();

CREATE TABLE chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  visitor_id uuid NOT NULL REFERENCES users(id),
  reveal_state text NOT NULL DEFAULT 'NONE' CHECK (reveal_state IN ('NONE', 'REQUESTED', 'ACCEPTED', 'DECLINED')),
  reveal_requested_by uuid REFERENCES users(id),
  owner_telegram_version bigint,
  visitor_telegram_version bigint,
  owner_read_id bigint NOT NULL DEFAULT 0,
  visitor_read_id bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_id != visitor_id),
  CHECK (reveal_requested_by IS NULL OR reveal_requested_by IN (owner_id, visitor_id)),
  CHECK (
    (reveal_state IN ('REQUESTED', 'ACCEPTED') AND owner_telegram_version IS NOT NULL AND visitor_telegram_version IS NOT NULL) OR
    (reveal_state NOT IN ('REQUESTED', 'ACCEPTED') AND owner_telegram_version IS NULL AND visitor_telegram_version IS NULL)
  ),
  UNIQUE(listing_id, visitor_id)
);
CREATE INDEX chats_owner_idx ON chats(owner_id);
CREATE INDEX chats_visitor_idx ON chats(visitor_id);

CREATE TABLE chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id),
  sender_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  contact_warning boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_history_idx ON chat_messages(chat_id, id DESC);
CREATE INDEX chat_messages_sender_idx ON chat_messages(chat_id, sender_id);

-- History of mutual consent survives a later change of handle or an exchange reset.
CREATE TABLE chat_contact_exchanges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  accepted_by uuid NOT NULL REFERENCES users(id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_by != accepted_by)
);
CREATE INDEX chat_contact_exchanges_chat_idx ON chat_contact_exchanges(chat_id);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id),
  author_id uuid NOT NULL REFERENCES users(id),
  subject_id uuid NOT NULL REFERENCES users(id),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'HIDDEN', 'BANNED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (author_id != subject_id),
  UNIQUE (chat_id, author_id)
);
CREATE INDEX reviews_public_idx ON reviews(subject_id) WHERE status = 'ACTIVE';

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id),
  reporter_id uuid NOT NULL REFERENCES users(id),
  subject_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (reason IN ('FRAUD', 'ABUSE', 'OTHER')),
  scope text NOT NULL CHECK (scope IN ('ON_PLATFORM', 'VERIFIED_TELEGRAM')),
  details text NOT NULL CHECK (length(details) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'REJECTED')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_id != subject_id),
  UNIQUE (chat_id, reporter_id)
);
CREATE INDEX reports_status_idx ON reports(status, created_at DESC);

CREATE TABLE site_locales (
  code text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  messages jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_content (
  key text PRIMARY KEY,
  translations jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  reason text,
  before_data jsonb,
  after_data jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor, idempotency_key)
);

INSERT INTO site_locales (code, name, active) VALUES ('ru', 'Русский', true);

INSERT INTO site_content (key, translations) VALUES
('about', '{"ru":{"title":"О площадке","body":"hwforai помогает покупателям и продавцам находить серверы, ускорители и комплектующие для задач искусственного интеллекта. Условия поставки и оплаты участники согласуют напрямую в чате."}}'),
('rules', '{"ru":{"title":"Правила площадки","body":"Публикуйте достоверные сведения об оборудовании и условиях поставки. Начинайте общение в чате на площадке. Раскрывайте привязанные контакты Telegram только по взаимному согласию."}}'),
('safety', '{"ru":{"title":"Безопасность сделок","body":"Проверьте контрагента, наличие оборудования и условия поставки до оплаты. Мы рассматриваем жалобы на переписку на площадке и общение по Telegram, раскрытому в чате. Переписка по другим контактам остаётся ответственностью собеседников."}}'),
('privacy', '{"ru":{"title":"Конфиденциальность","body":"Другие участники видят ваш публичный ник, город, страну, тип участника и репутацию. Email используется для подтверждения аккаунта. Привязанный Telegram доступен собеседнику после взаимного согласия."}}');

INSERT INTO categories (slug,name,short_name,description,icon,sort_order,attribute_keys) VALUES
('gpu','Графические ускорители','GPU и ускорители','Серверные GPU, модули SXM, PCIe и вычислительные ускорители.','gpu',10,ARRAY['Модель','Видеопамять','Форм-фактор','Интерфейс']),
('servers','GPU-серверы и узлы','Серверы','Готовые GPU-серверы, вычислительные узлы и barebone-платформы.','servers',20,ARRAY['Модель','Количество GPU','Процессор','Оперативная память']),
('cpu','Серверные процессоры','Процессоры','Серверные CPU и комплекты процессоров.','cpu',30,ARRAY['Модель','Сокет','Количество ядер','Теплопакет']),
('memory','Серверная память','Память','Модули DDR, ECC RDIMM, LRDIMM и память для серверных платформ.','memory',40,ARRAY['Тип памяти','Объём','Скорость','Форм-фактор']),
('storage','Накопители и системы хранения','Хранение данных','Серверные SSD, NVMe, HDD и системы хранения данных.','storage',50,ARRAY['Модель','Объём','Интерфейс','Форм-фактор']),
('network','Сеть и межсоединения','Сеть','InfiniBand, Ethernet, адаптеры, коммутаторы, оптика и кабели.','network',60,ARRAY['Модель','Протокол','Скорость порта','Количество портов']),
('racks','Стойки и корпуса','Стойки','Серверные стойки, корпуса, салазки и монтажные комплекты.','racks',70,ARRAY['Высота, U','Ширина','Глубина','Нагрузка']),
('power','Электропитание','Электропитание','Серверные блоки питания, ИБП и распределители питания для стоек.','power',80,ARRAY['Модель','Мощность','Напряжение','Форм-фактор']),
('cooling','Охлаждение','Охлаждение','Воздушное и жидкостное охлаждение, CDU, коллекторы и радиаторы.','cooling',90,ARRAY['Модель','Тип охлаждения','Мощность отвода тепла','Совместимость']),
('components','Комплектующие и ЗИП','Комплектующие','Материнские платы, райзеры, backplane, контроллеры и запасные части.','components',100,ARRAY['Модель','Артикул','Форм-фактор','Совместимость']);
