# Локальная эксплуатация hwforai

См. [обновление Docker Desktop](../README.md#обновление-docker-desktop-на-macos) и [развёртывание на VPS](ADMIN_VPS.md).

## Резервная копия и восстановление

Из папки с текущим `compose.yaml` выполните команды. Подставьте своё имя проекта, если оно отличается от `hwforai-maxv`. Копия появится рядом с папкой проекта. В ней содержатся объявления, фотографии, переписка и данные пользователей.

```sh
backup="hwforai-before-$(date +%Y%m%d-%H%M%S).dump"
docker compose -p hwforai-maxv exec -T postgres pg_dump -U hwforai -d hwforai --format=custom --file="/tmp/$backup" &&
docker compose -p hwforai-maxv exec -T postgres pg_restore --list "/tmp/$backup" &&
docker compose -p hwforai-maxv cp "postgres:/tmp/$backup" "../$backup" &&
chmod 600 "../$backup"
```

Для проверки отката откройте исходники предыдущей версии в отдельной папке и восстановите копию в чистую базу отдельного проекта. Выберите свободные `APP_PORT` и `MAILPIT_UI_PORT` перед запуском восстановленного приложения рядом с текущим.

```sh
docker compose -p hwforai-recovery up -d --wait postgres
docker compose -p hwforai-recovery cp /path/to/backup.dump postgres:/tmp/backup.dump
docker compose -p hwforai-recovery exec -T postgres pg_restore -U hwforai -d hwforai --exit-on-error --no-owner /tmp/backup.dump
```

Для базы вне Compose используйте `pg_dump --format=custom --file=hwforai.backup "$DATABASE_URL"` и проверяйте восстановление в отдельную базу командой `pg_restore --exit-on-error --no-owner --dbname="$RECOVERY_DATABASE_URL" hwforai.backup`. Ограничьте доступ к резервным копиям и шифруйте хранилище.
