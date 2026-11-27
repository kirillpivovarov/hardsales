#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_lib=${HWFORAI_BACKUP_LIB:-/usr/local/lib/hwforai/backup-lib.sh}
source "$backup_lib"
backup_kind=BACKUP
trap finish_backup EXIT
start_backup

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="hwforai-$stamp.dump.age"
stem=${name%.age}
available=$(df -P -B1 "$backup_work" | awk 'NR==2 { print $4 }')
previous_size=0
if [[ -r "$backup_state/last-backup-bytes" ]]; then read -r previous_size < "$backup_state/last-backup-bytes"; fi
if [[ ! $available =~ ^[0-9]+$ || ! $previous_size =~ ^[0-9]+$ ]] ||
  ((available < previous_size * 2)); then
  printf '%s\n' 'Недостаточно места для резервной копии.' >&2
  exit 1
fi
database_usage=$(hwcompose exec -T postgres df -P /var/lib/postgresql/data | awk 'NR==2 { gsub(/%/,"",$5); print $5 }')
if [[ $database_usage =~ ^[0-9]+$ ]]; then disk_free=$((100 - database_usage)); fi

hwcompose exec -T -u postgres postgres pg_dump -U postgres -d hwforai --format=custom > "$backup_work/$stem"
test -s "$backup_work/$stem"
hwcompose exec -T -u postgres postgres pg_restore --list < "$backup_work/$stem" >/dev/null
age --encrypt -R "$backup_config/recipients.txt" --output "$backup_work/$name" "$backup_work/$stem"
report_bytes=$(wc -c < "$backup_work/$stem" | tr -d '[:space:]')
rm -- "$backup_work/$stem"
(cd "$backup_work" && sha256sum "$name" > "$name.sha256")
remote copy copyto "$backup_work/$name" "offsite:hwforai/daily/$name"
remote copy copyto "$backup_work/$name.sha256" "offsite:hwforai/daily/$name.sha256"
if [[ $(date +%u) == 7 ]]; then
  remote copy copyto "$backup_work/$name" "offsite:hwforai/weekly/$name"
  remote copy copyto "$backup_work/$name.sha256" "offsite:hwforai/weekly/$name.sha256"
fi
printf '%s\n' "$report_bytes" > "$backup_work/last-backup-bytes"
mv -- "$backup_work/last-backup-bytes" "$backup_state/last-backup-bytes"
report_ok=true
printf 'Резервная копия сохранена: %s\n' "$name"
