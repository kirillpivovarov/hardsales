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

Примеры браузерных прогонов на изолированных стендах.

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
HWFORAI_TRUST_QA_URL=http://127.0.0.1:3100 python tests/trust_e2e.py
```

Браузерная матрица включает гостя, покупателя, прямого продавца, участника в режиме агента, администратора и модератора на мобильной, планшетной и настольной ширине. При изменении схемы проверяйте чистую базу и обновление копии предыдущей версии. Сверяйте данные и контрольные суммы уже опубликованных миграций.

### Каталог и модерация

Используйте отдельный демостенд с `EXCHANGE_DEMO_FEATURES=true`.

```sh
HWFORAI_QA_BASE=http://127.0.0.1:3100 HWFORAI_QA_MAILPIT_URL=http://127.0.0.1:8125 \
  python tests/catalog_staff_ux_e2e.py
```
