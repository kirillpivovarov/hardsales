#!/usr/bin/env bash

backup_config=${HWFORAI_BACKUP_CONFIG_DIR:-/etc/hwforai/backup}
compose_config=${HWFORAI_COMPOSE_CONFIG_DIR:-/etc/hwforai}
backup_state=${HWFORAI_BACKUP_STATE_DIR:-/var/lib/hwforai-backup}
backup_work=
restore_db=
report_ok=false
report_bytes=
disk_free=

hwcompose() {
  docker compose --env-file "$compose_config/release.env" -f "$compose_config/compose.vps.yaml" "$@"
}

remote() {
  local mode=$1
  shift
  rclone --config "$backup_config/rclone-$mode.conf" "$@"
}

start_backup() {
  install -d -m 700 "$backup_state"
  backup_work=$(mktemp -d "$backup_state/work.XXXXXXXX")
}

report() {
  local finished now body token_file
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ -n ${OPS_API_URL:-} && -r "$backup_config/monitor.token" ]]; then
    token_file="$backup_work/auth-header"
    printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$backup_config/monitor.token")" > "$token_file"
    body="{\"kind\":\"$backup_kind\",\"ok\":$report_ok,\"finishedAt\":\"$finished\""
    if [[ $report_bytes =~ ^[0-9]+$ ]]; then body+=",\"sizeBytes\":$report_bytes"; fi
    if [[ $disk_free =~ ^[0-9]+$ ]]; then body+=",\"diskFreePercent\":$disk_free"; fi
    curl --fail --silent --max-time 15 --output /dev/null --request POST --header "@$token_file" --header 'Content-Type: application/json' \
      --data-binary "$body}" "${OPS_API_URL%/}/api/v1/health/ops/backup" || printf '%s\n' 'Не удалось передать состояние в приложение.' >&2
    rm -f -- "$token_file"
  fi
  now=${BACKUP_HEARTBEAT_URL:-}
  if [[ $backup_kind == RESTORE ]]; then now=${RESTORE_HEARTBEAT_URL:-}; fi
  if [[ -n $now ]]; then
    if [[ $report_ok != true ]]; then now="${now%/}/fail"; fi
    printf 'url = "%s"\n' "$now" | curl --config - --fail --silent --max-time 15 --output /dev/null ||
      printf '%s\n' 'Не удалось передать пульс внешнему мониторингу.' >&2
  fi
}

finish_backup() {
  local status=$?
  trap - EXIT
  if [[ -n $restore_db ]]; then
    hwcompose exec -T -u postgres postgres dropdb -U postgres --if-exists "$restore_db" >/dev/null 2>&1 || status=1
  fi
  if [[ -n $backup_work && -d $backup_work ]]; then
    if ((status != 0)); then report_ok=false; fi
    report || true
    rm -rf -- "$backup_work"
  fi
  exit "$status"
}
