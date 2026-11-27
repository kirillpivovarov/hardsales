# HTTP API hwforai


Пути в таблицах указаны относительно `/api/v1`. Защищённые маршруты используют cookie `hwforai_session`. Тела по умолчанию принимаются как `application/json`. Ошибка возвращает HTTP-статус и `message` строкой или массивом строк. Основные статусы включают `401` для отсутствующей сессии, `403` для недостатка прав, `404` для недоступной сущности, `409` для конфликта и `429` для ограничения частоты.

### Авторизация

| Метод и путь | Запрос и ответ |
| --- | --- |
| `GET /auth/captcha` | Подписанная задача ALTCHA для регистрации. |
| `POST /auth/register` | `username`, `email`, `password`, `role`, `participantType`, `country`, `city`, `telegram`, `captchaToken`, а для компании также `companyName`. |
| `POST /auth/login` | `login` и `password`. Возвращает вызов подтверждения или `{user}` для готового демоаккаунта. |
| `POST /auth/verify` | `{challengeId, code}`. Устанавливает cookie и возвращает `{user}`. |
| `POST /auth/resend` | `{challengeId}`. Возвращает новый вызов подтверждения. |
| `GET /auth/me` | `{user}` с профилем и признаком обязательной смены пароля. Без сессии возвращает `{user:null}`. |
| `POST /auth/logout` | Завершает текущую сессию. |
| `PATCH /auth/profile` | `displayName`, `city`, `country`, `telegram`, `companyName` для компании. |
| `POST /auth/password` | `{currentPassword, newPassword}`. |
| `PATCH /auth/credentials` | `{currentPassword, newPassword, username?}` для администратора. |

Вызов подтверждения содержит `challengeId`, `expiresIn` в секундах и маскированный `email`. Роли при регистрации имеют значения `BUYER`, `SELLER` и `BOTH`, типы участника — `COMPANY` и `INDIVIDUAL`. Статус ответа перед вводом кода не раскрывает, зарегистрирован ли этот email.

### Каталог и объявления

| Метод и путь | Назначение |
| --- | --- |
| `GET /categories`, `GET /locales`, `GET /content` | Категории, действующие словари и страницы. |
| `GET /listings` | Страница поиска `{items, total, page, limit, locked}`. Гость получает пустой список и `locked: true`. |
| `GET /listings/mine` | Собственные объявления. |
| `GET /listings/:id` | Карточка с проверкой доступа. |
| `GET /listings/:listingId/images/:imageId` | Обработанный WebP с проверкой доступа к карточке. |
| `POST /listings`, `PATCH /listings/:id` | Создание и изменение объявления. |
| `DELETE /listings/:id`, `POST /listings/:id/restore` | Архивирование и восстановление. |

Поиск принимает `q`, пагинацию `page` и `limit` и сортировку `sort`. При `q` по умолчанию используется релевантность, без текста — новизна. Допустимы `relevance`, `newest`, `price-asc` и `price-desc`. Сортировка по цене использует стоимость единицы в USD. Договорные цены и цены без курса идут в конце. Фильтр `category` принимает код и включает подкатегории. Другие фильтры включают `kind`, `ownerType`, `availability`, `condition`, `originScope`, `priceMode`, `vat`, `counterparty`, `originCountry`, `destinationCountry`, `ownerCountry`, `city`, `paymentMethod`, `deliveryIncluded`, `customsIncluded`, `priceMin`, `priceMax` и `currency`. Ценовой диапазон применяется к одной единице. Без параметра `currency` сравниваются эквиваленты в USD. Псевдоним фильтра `originCountry` — `country`.

Для создания объявления передайте `categoryId`, `title`, `description` и параметры направления. Передайте `kind` (`SELL` или `BUY`) для аккаунта, имеющего обе стороны, или используйте доступную по умолчанию сторону. В фиксированной цене `price` задаётся сумма за единицу до 999 999 999,99. Карточка возвращает `totalPrice` за всё количество и, если курс задан, эквиваленты `priceUsd` и `totalPriceUsd`. Для покупателя нужны `destinationCountry`, `deliveryBy` и `originScope`. Для `COUNTRY` передайте `originCountry`, для `DOMESTIC` он совпадает со страной получения. Продавцу нужны `availability` и география отгрузки. Для склада требуется `stockCity`.

В категориях `gpu` и `servers` и их подкатегориях при создании и редактировании укажите `modelId`. Отсутствие модели возвращает `400 MODEL_REQUIRED` с `field: "modelId"`. Сохранить карточку с собственной моделью на проверке можно сразу. Поиск совпадений по ней начнётся после одобрения. `GET /models/suggest?q=H100` возвращает подходящие конкретные модели. Сотрудники находят старые карточки без модели через `GET /admin/listings?withoutModel=true`.

Для конкретного пункта отправления укажите `originScope: "COUNTRY"` и двухбуквенный код `originCountry`. Для гибкой отгрузки передайте `originScope: "ANY"` и `originCountry: null`. Старое тело с конкретным кодом без `originScope` остаётся допустимым. Частичное обновление без двух полей сохраняет прежнюю географию. Фильтр конкретной страны включает гибкие заявки и предложения. `originCountry=ANY` выбирает только записи с гибкой географией. В `deliveryBy` покупатель передаёт крайний срок поставки, продавец может передать последний день публикации предложения. Цена хранится до сотых, договорная цена передаётся как `null`.

### Загрузка фотографий

Для новых файлов отправляйте `multipart/form-data` на `POST /listings`, `PATCH /listings/:id` или `PATCH /admin/listings/:id`. Поле `data` содержит JSON объявления до 64 КиБ. Каждый новый файл передаётся частью `images`. В `data.imageOrder` укажите будущий порядок, используя UUID сохранённых фото и объекты с индексом нового файла с нуля.

```json
{
  "imageOrder": [
    { "fileIndex": 0 },
    "c1402d63-9317-4f35-9d28-562ee554f793"
  ]
}
```

Первая позиция задаёт обложку. Пустой массив удаляет все фото. Обновление полей без `imageOrder` сохраняет фотографии. Для перестановки и удаления без новых файлов достаточно JSON. При включённой защите контактов для новых фото требуется `data.imageContactAcknowledged: true`. Отсутствие подтверждения возвращает `400 PHOTO_CONTACT_CONFIRMATION_REQUIRED`. Некорректный файл или ссылка на чужое фото приводит к отклонению всего изменения. Превышение размера возвращает `413`, занятый обработчик может вернуть `503`. Поле карточки `images` возвращает упорядоченные `{id, url, width, height}`.

### Чаты и отзывы

| Метод и путь | Запрос и назначение |
| --- | --- |
| `POST /chats`, `GET /chats` | Открывает диалог по `{listingId}` или возвращает диалоги участника. |
| `GET /chats/:id` | Состояние диалога, партнёр и доступные действия. `telegram` содержит контакты при действующем согласии, `telegramChanged` содержит признаки изменения `mine` и `partner` после прежнего обмена. |
| `GET /chats/:id/messages` | Порция истории по исключающей границе `before` или `after` и `limit` от 1 до 100. |
| `POST /chats/:id/messages` | `{body}`. При включённой защите контакты до согласия возвращают `422 CONTACT_BLOCKED` с `kinds`. Нейтральное сообщение сохраняется. При выключенной защите действует предупреждение. |
| `PATCH /chats/:id/read` | `{messageId}` для маркера чтения. |
| `PATCH /chats/:id/reveal` | `{action: "REQUEST"}` создаёт запрос на уровне пары. Для `ACCEPT` и `DECLINE` получатель передаёт `requestId` из поля `revealRequestId`. |
| `POST /chats/:id/reviews` | `{rating, comment}` с оценкой от 1 до 5. |
| `POST /chats/:id/reports` | `{reason, scope, details}`. Области `ON_PLATFORM` и `VERIFIED_TELEGRAM`. |

### Администрирование

Рабочие маршруты модерации доступны сотрудникам с ролями `ADMIN` и `MODERATOR` после подтверждения почты и смены временного пароля. Страницы профилей, объявлений, жалоб, отзывов и действий доступны через `GET /admin/users`, `/admin/listings`, `/admin/reports`, `/admin/reviews`, `/admin/audit`. Поиск по объявлениям в админке также учитывает публичное имя автора. Справочники доступны через `GET /admin/categories`, `/admin/content`, `/admin/locales`.

Журнал фиксирует вход и выход сотрудников, смену реквизитов, создание модераторов, редактирование и смену статусов. Просмотр контактных данных профиля, списка с такими контактами, жалоб и переписки по жалобе тоже создаёт запись. Новая запись сотрудника содержит его логин на момент действия, постоянный `actorUserId` и `actorRole`. У автоматизации роль `AGENT`, а идентификатор сотрудника равен `null`. Сведения в исторической записи зависят от версии, на которой она появилась. Пароли и почтовые коды в журнале отсутствуют. [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

| Метод и путь | Назначение |
| --- | --- |
| `POST /admin/moderators` | Создание модератора из сессии администратора. Тело `{username, displayName, email, temporaryPassword}`. |
| `GET /admin/users/:id` | Профиль по точному идентификатору. Модератор видит контакты покупателей и продавцов. |
| `PATCH /admin/users/:id` | Редактирование профиля. |
| `GET /admin/listings/:id`, `PATCH /admin/listings/:id` | Чтение и правка объявления. |
| `GET /admin/reviews/:id`, `GET /admin/reports/:id` | Отзыв или жалоба по точному идентификатору. Списки `/admin/reviews` и `/admin/reports` поддерживают `subjectId`. |
| `GET /admin/reports/:id/messages` | Переписка по жалобе с пагинацией и аудитом доступа. |
| `PATCH /admin/:entity/:id/status` | Изменение статуса профиля, объявления, отзыва или жалобы. Тело `{status, reason}`. |
| `POST /admin/categories`, `PATCH /admin/categories/:id` | Создание и обновление категории. |
| `PUT /admin/content/:key`, `PUT /admin/locales/:code` | Запись страницы или локали. |
| `GET /admin/audit?actorRole=MODERATOR` | Журнал с фильтром по роли `ADMIN`, `MODERATOR`, `AGENT`, `BUYER` или `SELLER`. |

Для CLI и MCP есть выделенный HTTP-маршрут модерации `users` и `listings`. Установите `MODERATION_AGENT_TOKEN` длиной от 32 символов и передавайте его только интеграции. Для новой операции укажите уникальный `Idempotency-Key` длиной 8–128 символов из латинских букв, цифр, точки, дефиса или подчёркивания.

```sh
curl --fail-with-body --request PATCH \
  --url "$APP_ORIGIN/api/v1/agent/moderation/listings/$LISTING_ID" \
  --header "Authorization: Bearer $MODERATION_AGENT_TOKEN" \
  --header "Idempotency-Key: $MODERATION_OPERATION_ID" \
  --header 'Content-Type: application/json' \
  --data '{"status":"FROZEN","reason":"Проверка полученной жалобы"}'
```

Доступны `FROZEN`, `ACTIVE` и `BANNED`. Повтор сетевого запроса с прежним ключом и данными возвращает `replayed: true`. Изменение тела под прежним ключом возвращает `409`. Действия проходят через журнал модерации.

### Закрытая биржа

| Область | Основные маршруты |
| --- | --- |
| Настройки и фоновые задачи | `GET /platform/features`, `GET /admin/settings`, `PUT /admin/settings/:key`, `GET /admin/jobs` |
| Уведомления и защищённые ссылки | `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all`, `GET\|POST /actions/:token` |
| Приглашения и анкеты | `GET\|POST /admin/invites`, `PATCH /admin/invites/:id/revoke`, `GET\|PUT /onboarding`, `POST /auth/rules/accept`, `GET /admin/users/:id/onboarding` |
| Актуальность | `GET /me/actuality`, `POST /listings/:id/actuality`, `POST /listings/:id/extend`, `POST /me/actuality/confirm-all`, `POST\|DELETE /me/pause`, `POST /me/actuality/resume` |
| Раскрытия | `GET /disclosures`, `GET /disclosures/:id`, `POST /disclosures/:id/already-known`, `GET /admin/disclosures`, `POST /admin/disclosures/:id/notes` |
| Представительство | `GET\|PATCH /me/representation`, `GET\|POST /me/principals`, `PATCH\|DELETE /me/principals/:id`, `PUT /me/agent-fee`, `POST /me/company-email`, `GET /admin/principals` |
| Справочник | `GET /models`, `GET /models/suggest`, `GET /models/:id/analogs`, `POST /models/proposals`, `GET /admin/models` |
| Синхронизация | `GET /admin/catalog-sync/items`, `GET /admin/catalog-sync/sources`, `POST /admin/catalog-sync/run` |
| Совпадения | `GET /matches`, `GET /matches/counts`, `GET /matches/:id`, `POST /matches/:id/chat`, `POST /matches/:id/decline`, `GET /admin/matches` |
| Проверка и сделки | `GET /me/trust`, `GET\|POST /documents`, `GET /documents/:id/file`, `GET /payment-terms`, `GET /deals`, `GET /deals/:id`, `POST /deals/:id/status`, `GET /admin/verification` |
| Контакты | Ошибка `400 CONTACT_IN_FIELD` с `field` и `kinds` в защищённых полях. `GET /admin/contact-blocks?userId=&from=&to=&page=` показывает блокировки администратору. |
| Telegram | `GET /me/telegram`, `POST /me/telegram/link`, `DELETE /me/telegram`, `POST /telegram/webhook`, `GET /admin/telegram`, `POST /admin/telegram/users/:id/unlink`. Вебхук требует `X-Telegram-Bot-Api-Secret-Token`. |
| Ручной запрос актуальности | `POST /admin/actuality/ask-now`, `POST /admin/actuality/remind-now`. Доступны администратору в деморежиме. |
| Персональные данные | `POST /auth/consent`, `GET\|POST /me/data-requests`, `GET /me/data-requests/:id/export`, `GET /admin/data-requests`, `POST /admin/data-requests/:id/export\|delete\|reject`, `GET /admin/users/:id/consents`. |
| Показатели пробы | `GET /admin/pilot-metrics?from=&to=`, `GET /admin/pilot-metrics.csv?from=&to=`. Агрегаты доступны модератору и администратору. `GET /admin/pilot-accounts` и изменение ориентиров доступны администратору. |
| Дубли лотов | `GET /listings/:id/lot-members`, `GET /me/lot-requests`, `POST /me/lot-requests/:id`, `POST /listings/:id/duplicate-appeal`. Сотрудники используют `GET /admin/lot-groups`, `GET /admin/lot-groups/:id` и действия `principal-requests`, `shared-principal`, `resolve`, `dissolve`, `members/:listingId/restore` через `POST` под выбранной группой. |
| Ручное сведение | `GET /admin/near-misses`, `POST /admin/near-misses/propose`, `POST\|DELETE /admin/near-misses/dismiss`. Доступны модератору и администратору. В совпадениях `source` содержит `SYSTEM` или `OPERATOR`. |

Маршруты настройки и управления сотрудниками требуют сессии администратора. Ручная проверка в рамках полномочий сотрудника фиксируется в журнале. Код приглашения передаётся как `inviteCode` при регистрации. Для публичного каталога доступны фильтры `model`, `withAnalogs`, `representation`, `principalConfirmed`, `showAll` и сортировка `trust`. Служебные поля, контакты и файлы возвращаются по правам конкретного участника.

Регистрация передаёт `pdConsent: true`, `pdPolicyVersion` из `GET /auth/me` и необязательное `infoEmailConsent`. При смене политики запись от имени участника возвращает `403 PD_CONSENT_REQUIRED`, пока он не примет текущую версию. Чтение и запросы по своим данным доступны. Архив выгрузки возвращается владельцу в формате gzip в течение семи дней.

### Проба и эксплуатация

| Метод и путь | Назначение |
| --- | --- |
| `GET\|POST /admin/presets/trial` | Предпросмотр и атомарное применение. Администратор передаёт `fxRates` с курсами RUB, USD, EUR, CNY, KZT, AED. Не пройденные проверки возвращают `409`. |
| `GET /admin/jobs/available`, `POST /admin/jobs/:name/run` | Доступные по роли задачи и запуск с отдельным слотом. Подтверждение запуска рассылки в рабочем режиме передаётся полем `confirm`. Повтор в течение минуты возвращает `429`. |
| `GET /admin/mail-queue`, `POST /admin/mail-queue/:source/:id/retry` | `source=deliveries\|outbox`, фильтры `status,kind,from,to,page,limit`. Адреса для модератора маскируются. Перезапуск доступен для ошибки доставки. |
| `POST /admin/mail/test` | Администратор передаёт `{to}` для SMTP-проверки. |
| `GET /admin/readiness`, `PUT /admin/readiness/:key` | Администратор получает чек-лист и сохраняет ручные отметки `{checked}`. |
| `GET\|POST /admin/rules/schedule` | Администратор планирует публикацию заготовки через `{version,effectiveAt}`. Минимальный срок предупреждения семь дней. |
| `GET /health/ops`, `POST /health/ops/backup` | Авторизация Bearer из `OPS_MONITOR_TOKEN`. Отчёт включает `kind,ok,finishedAt,sizeBytes,diskFreePercent`. |

### Участники, сделки и споры

| Метод и путь | Назначение |
| --- | --- |
| `PATCH /me/trade-sides` | Поле `tradeSides` принимает список `BUY` и `SELL`. Регистрация с обеими сторонами передаёт `role: "BOTH"`. Сотрудники используют отдельные роли. |
| `POST /chats/:id/deal`, `GET /deals?pairUserId=` | Повторная сделка в чате раскрытой пары и список сделок пары. |
| `GET\|POST /disputes`, `GET /disputes/:id` | Список и карточка спора, открытие по сделке. |
| `POST /disputes/:id/position\|materials\|messages\|review\|withdraw` | Позиция стороны, материалы, ответы, пересмотр и отзыв. Для отправки файла используется `multipart/form-data`. |
| `GET /disputes/:id/materials/:materialId/file` | Материал доступен автору либо уполномоченному сотруднику спора. |
| `GET /admin/disputes`, `GET /admin/disputes/:id/evidence` | Очередь споров и доказательства. |
| `POST /admin/disputes/:id/notify\|start-review\|decide` | Уведомление, рассмотрение и решение с аудитом. |
| `GET /notifications/counts`, `GET /chats/unread-count` | Счётчики для шапки и чатов. |

Раскрытие возвращает признак подтверждённого ника в `telegramVerification`. При обязательном подтверждении коды отказа `TELEGRAM_NOT_VERIFIED_SELF` и `TELEGRAM_NOT_VERIFIED_PARTNER` объясняют, какой стороне нужно подключить бота.

Для сопровождения объявления доступны `GET /admin/users/:id/listing-options`, `POST /admin/users/:id/listings` и `POST /admin/listings/:id/review`. Черновик подтверждает или отклоняет владелец. Уровень и способ подтверждения возвращает `GET /me/verification`, сброс сотрудником доступен через `POST /admin/users/:id/verification-revoke`.
