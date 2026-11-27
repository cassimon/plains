#! /usr/bin/env bash
#
# Reinstate the local development database AND the durable file volumes from the
# snapshots taken by `scripts/db-backup.sh`. Restores all three (database,
# source-files, nomad-stash) so an imported experiment's original bytes are never
# stranded without their database references.
#
# Backups are taken with the application *stopped* (a `down` immediately follows
# a backup), because the pg_dump and the two volume tars are separate snapshots:
# they are only mutually consistent when nothing is writing to the database or
# the source-files / nomad-stash volumes while the backup runs.
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

# Validate the complete matching backup set BEFORE anything destructive. A
# database-only restore would leave imported_source_file rows pointing at bytes
# that no longer exist, so refuse to proceed on a partial set.
for f in "$DUMP" "$SOURCES" "$STASH"; do
    if [ ! -s "$f" ]; then
        echo "[db-restore] ERROR: missing or empty backup: ${f#"$ROOT_DIR"/}" >&2
        echo "[db-restore] refusing to restore a partial set — run scripts/db-backup.sh first." >&2
        exit 1
    fi
done

# After `down -v` the volumes are gone; `up -d --wait` recreates them.
echo "[db-restore] ensuring db + backend are up"
docker compose up -d --wait db backend

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

# 2. Durable original source files. Feed the .tar.gz straight to tar (its -z
# gunzips); no separate gunzip pass, so the stream is decompressed exactly once.
echo "[db-restore] restoring source-files from ${SOURCES#"$ROOT_DIR"/}"
docker compose exec -T backend sh -c 'rm -rf /var/lib/plains/source_files/* /var/lib/plains/source_files/.[!.]* /var/lib/plains/source_files/..?* 2>/dev/null || true'
docker compose exec -T -i backend tar -xzf - -C /var/lib/plains/source_files < "$SOURCES"

# 3. Stashed NOMAD upload archives.
echo "[db-restore] restoring nomad-stash from ${STASH#"$ROOT_DIR"/}"
docker compose exec -T backend sh -c 'rm -rf /var/lib/plains/nomad_stash/* /var/lib/plains/nomad_stash/.[!.]* /var/lib/plains/nomad_stash/..?* 2>/dev/null || true'
docker compose exec -T -i backend tar -xzf - -C /var/lib/plains/nomad_stash < "$STASH"

echo "[db-restore] done — dev database and durable files reinstated"
