# HTTP API

Префикс маршрутов — `/api/v1`. Тела запросов, где они предусмотрены, отправляются с `Content-Type: application/json`. Идентификаторы сущностей — UUID, кроме сообщений и строк аудита. Идентификатор сообщения и маркер истории передаются как целые числа. Маршруты, требующие входа, используют cookie `hwforai_session`.

Ошибки возвращают HTTP-статус и объект с полем `message`. Ошибки проверки полей могут вернуть массив сообщений. Для защищённых маршрутов предусмотрены статусы `401` для отсутствующей сессии и `403` для недостаточных прав. Отсутствующая или недоступная сущность может возвращать `404`. Повтор конфликтующего действия возвращает `409`. Ограничение частоты запросов возвращает `429`.

## Авторизация

| Метод и путь | Запрос и ответ |
| --- | --- |
| `POST /auth/register` | `username`, `email`, `password`, `role`, `participantType`, `country`, `city`, `telegram`. Для компании также `companyName`. Возвращает вызов подтверждения. |
| `POST /auth/login` | `login` (логин или email) и `password`. Возвращает вызов подтверждения или `{user}` для встроенных демоаккаунтов. |
| `POST /auth/verify` | `{challengeId, code}`, код — строка из шести цифр. Устанавливает cookie и возвращает `{user}`. |
| `POST /auth/resend` | `{challengeId}`. Возвращает новый вызов подтверждения. |
| `GET /auth/me` | `{user}` с профилем и признаком обязательной смены пароля. Без сессии — `{user:null}`. |
| `POST /auth/logout` | Завершает текущую сессию. |
| `PATCH /auth/profile` | `displayName`, `city`, `country`, `telegram` и для компании `companyName`. |
| `POST /auth/password` | `{currentPassword, newPassword}`. |
| `PATCH /auth/credentials` | `{currentPassword, newPassword, username?}`. Для изменения реквизитов администратора. |

Вызов подтверждения содержит `challengeId`, время действия `expiresIn` в секундах и маскированный `email`. Значения ролей при регистрации — `BUYER` и `SELLER`, типы участника — `COMPANY` и `INDIVIDUAL`.

## Каталог и объявления

| Метод и путь | Назначение |
| --- | --- |
| `GET /categories` | Доступные категории, порядок, характеристики и переводы. |
| `GET /locales` | Включённые языки и словари интерфейса. |
| `GET /content` | Опубликованные служебные страницы. |
| `GET /listings` | Результаты поиска. Гостю возвращается признак `locked` и пустой список. |
| `GET /listings/mine` | Собственные объявления. |
| `GET /listings/:id` | Доступная участнику карточка объявления. |
| `POST /listings` | Создание объявления текущей роли. |
| `PATCH /listings/:id` | Изменение своего объявления. |
| `DELETE /listings/:id` | Архивирование своего объявления. |
| `POST /listings/:id/restore` | Восстановление своего объявления из архива. |

Текстовый запрос `q` учитывает заголовок, описание, категорию, характеристики и город. Фильтр `category` принимает код категории и включает подкатегории. Доступные условия включают `kind`, `ownerType`, `availability`, `condition`, `originScope`, `priceMode`, `vat`, `counterparty`, `originCountry`, `destinationCountry`, `ownerCountry`, `city`, `paymentMethod`, `deliveryIncluded`, `customsIncluded`, `priceMin`, `priceMax` и `currency`. Параметр `sort` принимает `newest`, `price-asc` или `price-desc`. При ценовом диапазоне без валюты используется RUB.

Направление объявления хранится в `kind` (`SELL` или `BUY`). Типовая страница содержит `items`, `total`, `page` и `limit`. Параметры пагинации начинаются с единицы. Указанная цена хранится с точностью до сотых и сопровождается валютой. При договорной цене `price` равно `null`.

После истечения указанного срока поставки по UTC объявление пропадает из поиска и становится недоступно для начала нового чата. Доступ автора к объявлению и уже созданные чаты сохраняются. Для публикации обновите срок. Категория и её родительские категории должны быть активны.

Обязательные поля при создании включают `categoryId`, `title`, `description` и параметры направления. Покупатель передаёт `destinationCountry`, `deliveryBy` и `originScope`. Для `COUNTRY` передаётся и `originCountry`. Для `DOMESTIC` он совпадает со страной получения. Продавец передаёт `originCountry` и `availability`. Для `STOCK` требуется `stockCity`. Дополнительные условия — `quantity`, `condition`, `priceMode`, `price`, `currency`, `vat`, `paymentMethods`, `counterparty`, `deliveryIncluded`, `customsIncluded`, `specs`.

## Чат и отзывы

| Метод и путь | Запрос и назначение |
| --- | --- |
| `POST /chats` | `{listingId}`. Открывает существующий или создаёт новый диалог. |
| `GET /chats` | Диалоги текущего участника. |
| `GET /chats/:id` | Состояние диалога, партнёр, раскрытие Telegram и доступные действия. |
| `GET /chats/:id/messages` | Порция истории в порядке добавления. Задайте `before` или `after` как исключающую границу по ID сообщения и `limit` от 1 до 100. |
| `POST /chats/:id/messages` | `{body}`. Возвращает добавленное сообщение с признаком предупреждения при обнаружении контакта. |
| `PATCH /chats/:id/read` | `{messageId}`. Продвигает маркер чтения. |
| `PATCH /chats/:id/reveal` | `{action}`. Допустимы `REQUEST`, `ACCEPT`, `DECLINE`. |
| `POST /chats/:id/reviews` | `{rating, comment}`. Оценка от 1 до 5 после обмена сообщениями. |
| `POST /chats/:id/reports` | `{reason, scope, details}`. Допустимые области `ON_PLATFORM`, `VERIFIED_TELEGRAM`. |

## Администрирование

Маршруты `/admin/*` проверяют сессию действующего администратора. Страница профилей, объявлений, жалоб, отзывов или аудита возвращается по `GET /admin/users`, `/admin/listings`, `/admin/reports`, `/admin/reviews`, `/admin/audit`. Справочники возвращаются по `GET /admin/categories`, `/admin/content`, `/admin/locales`.

| Метод и путь | Назначение |
| --- | --- |
| `PATCH /admin/users/:id` | Редактирование данных профиля. |
| `GET /admin/listings/:id`, `PATCH /admin/listings/:id` | Чтение и правка объявления из админки. |
| `GET /admin/reports/:id/messages` | Переписка по конкретной жалобе с пагинацией. Доступ записывается в аудит. |
| `PATCH /admin/:entity/:id/status` | Изменение статуса профиля, объявления, отзыва или жалобы. Тело `{status, reason}`. |
| `POST /admin/categories`, `PATCH /admin/categories/:id` | Создание и обновление категории. |
| `PUT /admin/content/:key` | Создание или обновление служебной страницы. |
| `PUT /admin/locales/:code` | Создание или обновление локали. |

## Точка подключения CLI и MCP

Выделенный маршрут позволяет интеграции отправить те же операции модерации профилей и объявлений по HTTPS. Включите его переменной `MODERATION_AGENT_TOKEN` длиной не менее 32 символов. Выдавайте этот секрет только интеграции модерации и передавайте его в заголовке `Authorization`. Ключ `Idempotency-Key` длиной 8–128 символов из латинских букв, цифр, точки, дефиса и подчёркивания должен быть уникален для каждой намеренно новой операции. При сетевом повторе используйте прежний ключ и прежние данные.

```sh
curl --fail-with-body --request PATCH \
  --url "$APP_ORIGIN/api/v1/agent/moderation/listings/$LISTING_ID" \
  --header "Authorization: Bearer $MODERATION_AGENT_TOKEN" \
  --header "Idempotency-Key: $MODERATION_OPERATION_ID" \
  --header 'Content-Type: application/json' \
  --data '{"status":"FROZEN","reason":"Проверка полученной жалобы"}'
```

В пути поддерживаются `users` и `listings`. Основные значения статуса — `FROZEN` для заморозки, `ACTIVE` для восстановления после заморозки и `BANNED` для постоянной блокировки. Адаптер MCP или CLI может преобразовать команду пользователя в HTTP-запрос с тем же контрактом. Причина и результат проходят через журнал модерации.

Ответ изменения статуса содержит `{entity,id,status,changed,replayed}`. Повтор с прежним ключом и данными возвращает `replayed: true`. Изменение данных под существующим ключом возвращает `409`. Для архивного объявления агенту доступна окончательная блокировка.
