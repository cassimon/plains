#! /usr/bin/env bash
#
# Reinstate the local development database from the snapshot taken by
# `scripts/db-backup.sh`. Run automatically after the test suites so a test run
# leaves the dev database exactly as it was before.
#
# See CLAUDE.md → "Protecting the dev database during tests".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="$ROOT_DIR/db_backups"
DUMP="$BACKUP_DIR/latest.sql.gz"

if [ ! -s "$DUMP" ]; then
    echo "[db-restore] no non-empty backup at ${DUMP#"$ROOT_DIR"/} — nothing to restore" >&2
    exit 1
fi

# After `down -v` the volume is gone; `up -d --wait db` recreates it and Postgres
# auto-initialises an empty POSTGRES_DB, which we drop and rebuild from the dump.
echo "[db-restore] ensuring db service is up"
docker compose up -d --wait db

POSTGRES_USER="$(docker compose exec -T db printenv POSTGRES_USER | tr -d '\r')"
POSTGRES_DB="$(docker compose exec -T db printenv POSTGRES_DB | tr -d '\r')"

echo "[db-restore] recreating database '${POSTGRES_DB}'"
docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);"
docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
    -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

echo "[db-restore] restoring from ${DUMP#"$ROOT_DIR"/}"
gunzip -c "$DUMP" \
    | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null

echo "[db-restore] done — dev database reinstated"
