# Тестирование hwforai

По [чек-листу приёмки](QA_CHECKLIST.md) проверяйте роли, доступность и ключевые операции. Запускайте проверки на одноразовых базах с вымышленными аккаунтами и объявлениями. Проверки авторизации, админки и фотографий меняют реквизиты тестового администратора. Для таких прогонов выделяйте отдельные проекты Compose и порты.

```sh
export APP_PORT=13000 MAILPIT_UI_PORT=18025
export MODERATION_AGENT_TOKEN=local-qa-token-at-least-32-characters
docker compose -p hwforai-qa config --quiet
docker compose -p hwforai-qa up --build -d --wait
curl -fsS http://127.0.0.1:13000/api/v1/health
```

Проверку авторизации можно запустить внутри контейнера с доступом к его БД. Скопируйте туда тесты с их общими файлами. Рыночные проверки на хосте используют зависимости из `npm --prefix server ci`.

```sh
docker compose -p hwforai-qa cp server/test/. app:/app/server/test
docker compose -p hwforai-qa exec -T -u root app chmod -R a+rX test
docker compose -p hwforai-qa exec -T \
  -e HWFORAI_AUTH_TEST_URL=http://127.0.0.1:3001/api/v1 \
  -e MAILPIT_URL=http://mailpit:8025 \
  app npm run test:auth

HWFORAI_MARKET_TEST_URL=http://127.0.0.1:13000/api/v1 \
  MAILPIT_URL=http://127.0.0.1:18025 \
  node --test server/test/market.integration.test.mjs
HWFORAI_SEARCH_TEST_URL=http://127.0.0.1:13000 \
  node --test server/test/search.integration.test.mjs
```

Для повторного запуска теста рынка с изменённой учётной записью используйте `HWFORAI_MARKET_ADMIN_LOGIN` и `HWFORAI_MARKET_ADMIN_PASSWORD`. Для проверки фотографий на отдельном проекте с исходным администратором выполните следующие команды.

```sh
APP_PORT=13003 MAILPIT_UI_PORT=18027 docker compose -p hwforai-qa-media up --build -d --wait
docker compose -p hwforai-qa-media cp server/test/. app:/app/server/test
docker compose -p hwforai-qa-media exec -T -u root app chmod -R a+rX test
docker compose -p hwforai-qa-media exec -T \
  -e HWFORAI_MEDIA_TEST_URL=http://127.0.0.1:3001/api/v1 \
  -e MAILPIT_URL=http://mailpit:8025 \
  app node --test test/media.integration.test.mjs
```

Проверку полномочий сотрудников запускайте на отдельном демостенде с начальным паролем администратора. Значение `MODERATION_AGENT_TOKEN` должно быть таким же, как при запуске `app`.

```sh
APP_PORT=13006 MAILPIT_UI_PORT=18031 docker compose -p hwforai-qa-moderator up --build -d --wait
HWFORAI_MODERATOR_TEST_URL=http://127.0.0.1:13006/api/v1 MAILPIT_URL=http://127.0.0.1:18031 \
  node --test server/test/moderator.integration.test.mjs
```

Для проверки рабочего режима поднимите изолированный экземпляр с чистой PostgreSQL, настроенным `APP_ORIGIN` и Mailpit с обязательным STARTTLS. Передайте тесту соответствующие `APP_ORIGIN`, `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_EMAIL` и `BOOTSTRAP_ADMIN_PASSWORD`. Тесты регистрации используют решение настоящей локальной задачи ALTCHA. Тест инициализации администратора создаёт временные схемы и удаляет их после проверки.

```sh
HWFORAI_ADMIN_TEST_DATABASE_URL="$QA_DATABASE_URL" \
  node --test server/test/admin-bootstrap.integration.test.mjs
HWFORAI_PRODUCTION_TEST_URL=http://127.0.0.1:13001/api/v1 \
  MAILPIT_URL=http://127.0.0.1:18026 \
  node --test server/test/production.integration.test.mjs
```

Установите Playwright в отдельное Python-окружение. Если у вас свой Chromium, передайте его путь через `CHROMIUM_PATH`, `HWFORAI_TEST_CHROMIUM` и `HWFORAI_QA_CHROMIUM`.

```sh
python3 -m venv work/browser-qa-venv
source work/browser-qa-venv/bin/activate
python -m pip install playwright
python -m playwright install chromium
```

`tests/catalog_ui.py` проверяет главную «Железо для ИИ» с поиском и категориями, доступ к выдаче по ролям и расположение элементов на разных ширинах. Запускайте браузерные проверки на изолированных стендах.

```sh
HWFORAI_URL=http://127.0.0.1:13000 python tests/catalog_ui.py
HWFORAI_URL=http://127.0.0.1:13000 python tests/catalog_matching_e2e.py
HWFORAI_QA_BASE=http://127.0.0.1:13000 HWFORAI_QA_MAILPIT_URL=http://127.0.0.1:18025 \
  python tests/account_listing_e2e.py
HWFORAI_TEST_URL=http://127.0.0.1:13000 python tests/chat_e2e.py

APP_PORT=13002 MAILPIT_UI_PORT=18029 docker compose -p hwforai-qa-admin up --build -d --wait
HWFORAI_ADMIN_QA_URL=http://127.0.0.1:13002 python tests/admin_e2e.py

APP_PORT=13007 MAILPIT_UI_PORT=18032 docker compose -p hwforai-qa-moderation-ui up --build -d --wait
HWFORAI_QA_BASE=http://127.0.0.1:13007 HWFORAI_QA_MAILPIT_URL=http://127.0.0.1:18032 \
  python tests/contextual_moderation_e2e.py

APP_PORT=13004 MAILPIT_UI_PORT=18028 docker compose -p hwforai-qa-browser-media up --build -d --wait
HWFORAI_MEDIA_QA_URL=http://127.0.0.1:13004 python tests/listing_media_shipping_e2e.py

APP_PORT=13005 MAILPIT_UI_PORT=18030 docker compose -p hwforai-qa-countries up --build -d --wait
HWFORAI_COUNTRY_QA_URL=http://127.0.0.1:13005 python tests/country_priority_e2e.py
```

### Проверки закрытой биржи

Каждый сценарий с изменением данных запускайте на отдельной базе. Для браузерных проверок моделей, совпадений, актуальности и прав сотрудников включите `EXCHANGE_DEMO_FEATURES=true`. Тесты рейтинга самостоятельно включают нужные настройки на чистом стенде. Перед интеграционными тестами выполните `npm run build`.

```sh
node --test server/test/matching.rules.test.mjs server/test/trust-score.test.mjs

HWFORAI_INVITES_TEST_URL="$QA_API" MAILPIT_URL="$QA_MAILPIT" DATABASE_URL="$QA_DATABASE_URL" \
  node --test server/test/invites.integration.test.mjs
HWFORAI_ACTUALITY_TEST_URL="$QA_API" HWFORAI_ACTUALITY_TEST_DATABASE_URL="$QA_DATABASE_URL" \
  HWFORAI_ACTUALITY_TEST_MAILPIT_URL="$QA_MAILPIT" node --test server/test/actuality.integration.test.mjs
HWFORAI_DISCLOSURE_TEST_URL="$QA_API" MAILPIT_URL="$QA_MAILPIT" DATABASE_URL="$QA_DATABASE_URL" \
  node --test server/test/disclosure_representation.integration.test.mjs
HWFORAI_TRUST_TEST_URL="$QA_API" node --test server/test/trust.integration.test.mjs
HWFORAI_MODELS_TEST_DATABASE_URL="$QA_DATABASE_URL" HWFORAI_MODELS_TEST_URL="$QA_API" \
  node --test server/test/models.integration.test.mjs
```

`QA_API` содержит суффикс `/api/v1`, `QA_MAILPIT` — адрес Mailpit, `QA_DATABASE_URL` — строку подключения к одноразовой базе. Для теста актуальности окружение процесса теста должно содержать параметры SMTP. При запуске внутри сети Compose используйте `SMTP_HOST=mailpit` и `SMTP_PORT=1025` с отключёнными `SMTP_SECURE` и `SMTP_REQUIRE_TLS`. В тестах импорта ответы источников подменяются локальными данными, чтобы результат не зависел от доступности производителя.

```sh
HWFORAI_URL=http://127.0.0.1:3100 python tests/model_catalog_e2e.py
HWFORAI_URL=http://127.0.0.1:3100 python tests/automatic_matches_e2e.py
HWFORAI_QA_BASE=http://127.0.0.1:3100 python tests/actuality_e2e.py
HWFORAI_QA_BASE=http://127.0.0.1:3100 HWFORAI_QA_MAILPIT_URL=http://127.0.0.1:8125 \
  python tests/exchange_admin_e2e.py
HWFORAI_QA_BASE=http://127.0.0.1:3100 HWFORAI_QA_MAILPIT_URL=http://127.0.0.1:8125 \
  python tests/exchange_dialogs_e2e.py
HWFORAI_TRUST_QA_URL=http://127.0.0.1:3100 python tests/trust_e2e.py
```

`tests/exchange_admin_e2e.py` проверяет, что диалог редактирования модели виден сразу после открытия из длинного списка. Отдельно проверяются возврат фокуса и позиции прокрутки после отмены, сохранение нужной записи и журнал действий.

`tests/exchange_dialogs_e2e.py` проверяет отзыв приглашения и работу с ценовыми ориентирами на настольном экране, просмотр записей раскрытия и подтверждение полномочий на телефоне. Используйте отдельный демостенд с начальным паролем администратора для каждого сценария, который меняет его.

### Защита контактов, согласия и показатели

Каждому серверному сценарию выделите свой одноразовый стенд или чистую базу. `QA_API` заканчивается на `/api/v1`, `QA_ORIGIN` — адрес сайта, `QA_DATABASE_URL` — строка подключения к тестовой базе. Тест Telegram запускает собственное приложение с имитацией Bot API на loopback. Для него нужен отдельный SMTP Mailpit и чистая база.

```sh
node --test server/test/contact-guard.test.mjs
HWFORAI_CONTACT_TEST_URL="$QA_API" HWFORAI_CONTACT_TEST_DATABASE_URL="$QA_DATABASE_URL" \
  node --test server/test/contact-guard.integration.test.mjs
HWFORAI_PRIVACY_TEST_URL="$QA_API" DATABASE_URL="$QA_DATABASE_URL" MAILPIT_URL="$QA_MAILPIT" \
  node --test server/test/privacy.integration.test.mjs
HWFORAI_TELEGRAM_TEST_DATABASE_URL="$QA_DATABASE_URL" \
  node --test server/test/telegram.integration.test.mjs
HWFORAI_PILOT_TEST_DATABASE_URL="$QA_DATABASE_URL" \
  node --test server/test/pilot.integration.test.mjs
HWFORAI_LOTS_TEST_DATABASE_URL="$QA_DATABASE_URL" \
  node --test server/test/lots.integration.test.mjs
```

Для браузерных сценариев используйте отдельные демостенды с Mailpit и стандартными учётными записями. Для проверок оператора и групп лотов подготовьте демо-функции закрытой биржи.

```sh
export HWFORAI_URL="$QA_ORIGIN" HWFORAI_TEST_URL="$QA_ORIGIN" HWFORAI_QA_BASE="$QA_ORIGIN"
export HWFORAI_QA_MAILPIT_URL="$QA_MAILPIT"
python tests/contact_guard_e2e.py
python tests/privacy_e2e.py
python tests/telegram_ui_e2e.py
python tests/pilot_metrics_e2e.py
python tests/operator_matching_e2e.py
python tests/v2_workflow_e2e.py
```

Для групп лотов соберите сервер командой `npm --prefix server run build` и запустите локальный демостенд на отдельной базе с именем `hwforai_lots_ui_…` или `maxv_baseline_…`. Укажите ту же базу и адрес стенда. Тест создаёт временные сеансы, включает группировку и проверяет каталог, решение модератора и оспаривание дубля.

```sh
HWFORAI_URL="$QA_ORIGIN" HWFORAI_LOTS_TEST_DATABASE_URL="$QA_DATABASE_URL" \
  python tests/lots_ui_e2e.py
```

На рабочем тестовом стенде `production.integration.test.mjs` проверяет блокировку регистрации до публикации тестовой политики, затем выставляет тестовую версию `1.0`. После него прогоните `tests/production_e2e.py` на той же базе и с параметрами созданного тестового модератора `HWFORAI_PRODUCTION_MODERATOR_USERNAME` и `HWFORAI_PRODUCTION_MODERATOR_PASSWORD`. Задайте эти параметры перед серверным тестом, чтобы браузер мог войти той же учётной записью.

Браузерная матрица включает гостя, покупателя, прямого продавца, участника в режиме агента, администратора и модератора на мобильной, планшетной и настольной ширине. При изменении схемы проверяйте чистую базу и обновление копии предыдущей версии. Сверяйте данные и контрольные суммы уже опубликованных миграций.

### Каталог и модерация

Используйте отдельный демостенд с `EXCHANGE_DEMO_FEATURES=true`.

```sh
HWFORAI_QA_BASE=http://127.0.0.1:3100 HWFORAI_QA_MAILPIT_URL=http://127.0.0.1:8125 \
  python tests/catalog_staff_ux_e2e.py
```
