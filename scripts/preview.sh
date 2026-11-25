#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgresql://hwforai:hwforai@127.0.0.1:5432/hwforai}"
export DEMO_MODE="${DEMO_MODE:-true}"
export SMTP_HOST="${SMTP_HOST:-127.0.0.1}"
export SMTP_PORT="${SMTP_PORT:-1025}"
export SMTP_SECURE="${SMTP_SECURE:-false}"
export SMTP_REQUIRE_TLS="${SMTP_REQUIRE_TLS:-false}"
export MAIL_FROM="${MAIL_FROM:-no-reply@hwforai.local}"
export SERVE_WEB_DIR="${SERVE_WEB_DIR:-$PWD/web/dist}"
export PORT="${PORT:-3001}"
export HOST="${HOST:-127.0.0.1}"
while (( $# )); do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host=*) HOST="${1#*=}"; shift ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --strictPort) shift ;;
    *) printf 'Unknown preview argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
exec node --enable-source-maps server/dist/main.js
