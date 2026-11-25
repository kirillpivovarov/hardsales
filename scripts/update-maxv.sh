#!/bin/sh
set -eu

test -f compose.yaml || { echo 'Запустите скрипт из корня клона hardsales-maxv.' >&2; exit 1; }
test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"
test "$(git branch --show-current)" = maxv || { echo 'Текущая ветка должна быть maxv.' >&2; exit 1; }
git remote get-url origin | grep -Eiq '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)kirillpivovarov/hardsales(\.git)?$'
test -z "$(git status --porcelain --untracked-files=no)" || { echo 'Сохраните локальные правки перед обновлением.' >&2; exit 1; }
docker compose version >/dev/null
git pull --ff-only origin maxv
test "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)"
docker compose -p hwforai-maxv up --build -d --wait app
