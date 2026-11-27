#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_lib=${HWFORAI_BACKUP_LIB:-/usr/local/lib/hwforai/backup-lib.sh}
source "$backup_lib"
backup_kind=RESTORE
trap finish_backup EXIT
start_backup

name=$(remote read lsf 'offsite:hwforai/daily' --files-only --include '*.dump.age.sha256' |
  awk '/^hwforai-[0-9]{8}T[0-9]{6}Z\.dump\.age\.sha256$/' | LC_ALL=C sort | tail -n 1)
test -n "$name"
name=${name%.sha256}
remote read copyto "offsite:hwforai/daily/$name.sha256" "$backup_work/copy.sha256"
remote read copyto "offsite:hwforai/daily/$name" "$backup_work/copy.age"
read -r expected _ < "$backup_work/copy.sha256"
actual=$(sha256sum "$backup_work/copy.age" | cut -d ' ' -f 1)
[[ $expected =~ ^[0-9a-f]{64}$ && $actual == "$expected" ]]
age --decrypt -i "$backup_config/check.key" --output "$backup_work/copy.dump" "$backup_work/copy.age"
candidate="hwforai_verify_$(date -u +%Y%m%d%H%M%S)_$$"
hwcompose exec -T -u postgres postgres createdb -U postgres -O hwforai_app -T template0 "$candidate"
restore_db=$candidate
hwcompose exec -T -u postgres postgres pg_restore -U postgres -d "$restore_db" --no-owner --role=hwforai_app \
  --exit-on-error --single-transaction < "$backup_work/copy.dump"
sql="SELECT count(*) FROM schema_migrations WHERE file_name LIKE '%.sql';"
expected_count=$(hwcompose exec -T -u postgres postgres psql -XqAt -U postgres -d hwforai -v ON_ERROR_STOP=1 -c "$sql")
restored_count=$(hwcompose exec -T -u postgres postgres psql -XqAt -U postgres -d "$restore_db" -v ON_ERROR_STOP=1 -c "$sql")
[[ $restored_count =~ ^[1-9][0-9]*$ && $restored_count == "$expected_count" ]]
[[ $(hwcompose exec -T -u postgres postgres psql -XqAt -U postgres -d "$restore_db" -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM users WHERE role='ADMIN'") == 1 ]]
report_ok=true
printf 'Восстановление проверено: %s, миграций %s.\n' "$name" "$restored_count"
