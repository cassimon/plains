#! /usr/bin/env bash
#
# Reinstate the local development database AND the durable file volumes from the
# snapshots taken by `scripts/db-backup.sh`. Restores all three (database,
# source-files, nomad-stash) so an imported experiment's original bytes are never
# stranded without their database references.
#
# The complete backup set is validated (present, non-empty, gzip/tar-readable)
# BEFORE anything is destroyed, and the application is stopped for the duration
# of the restore so nothing can write mid-restore.
#
# See AGENTS.md → "Protecting the dev database during tests".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="$ROOT_DIR/db_backups"
DUMP="$BACKUP_DIR/latest.sql.gz"
SOURCES="$BACKUP_DIR/latest-source-files.tar.gz"
STASH="$BACKUP_DIR/latest-nomad-stash.tar.gz"

# Validate the complete matching set AND its integrity BEFORE anything
# destructive. A database-only or partial restore would strand source bytes.
for f in "$DUMP" "$SOURCES" "$STASH"; do
    if [ ! -s "$f" ]; then
        echo "[db-restore] ERROR: missing or empty backup: ${f#"$ROOT_DIR"/}" >&2
        echo "[db-restore] refusing to restore a partial set — run scripts/db-backup.sh first." >&2
        exit 1
    fi
done
gzip -t "$DUMP" || { echo "[db-restore] ERROR: dump failed gzip validation" >&2; exit 1; }
tar -tzf "$SOURCES" >/dev/null || { echo "[db-restore] ERROR: source-files tar is corrupt" >&2; exit 1; }
tar -tzf "$STASH" >/dev/null || { echo "[db-restore] ERROR: nomad-stash tar is corrupt" >&2; exit 1; }

# Quiesce the application before restoring.
echo "[db-restore] stopping the application (backend + frontend)"
docker compose stop backend frontend

echo "[db-restore] ensuring db is up"
docker compose up -d --wait db

POSTGRES_USER="$(docker compose exec -T db printenv POSTGRES_USER | tr -d '\r')"
POSTGRES_DB="$(docker compose exec -T db printenv POSTGRES_DB | tr -d '\r')"

# 1. PostgreSQL.
echo "[db-restore] recreating database '${POSTGRES_DB}'"
docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);"
docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
    -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

echo "[db-restore] restoring from ${DUMP#"$ROOT_DIR"/}"
gunzip -c "$DUMP" \
    | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null

# 2/3. Durable volumes via a one-off container (the app stays stopped).
echo "[db-restore] restoring source-files from ${SOURCES#"$ROOT_DIR"/}"
docker compose run --rm --no-deps -T backend sh -c \
    'rm -rf /var/lib/plains/source_files/* /var/lib/plains/source_files/.[!.]* 2>/dev/null; tar xzf - -C /var/lib/plains/source_files' \
    < "$SOURCES"

echo "[db-restore] restoring nomad-stash from ${STASH#"$ROOT_DIR"/}"
docker compose run --rm --no-deps -T backend sh -c \
    'rm -rf /var/lib/plains/nomad_stash/* /var/lib/plains/nomad_stash/.[!.]* 2>/dev/null; tar xzf - -C /var/lib/plains/nomad_stash' \
    < "$STASH"

echo "[db-restore] done — dev database and durable files reinstated"
