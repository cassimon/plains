#! /usr/bin/env bash
#
# Snapshot the local development database AND the durable file volumes before a
# destructive operation, so `scripts/db-restore.sh` can put everything back.
#
# The test scripts now run against an *isolated* Compose project and no longer
# call this, but a manual `docker compose down -v` still destroys three things:
#
#   1. the PostgreSQL database        (`app-db-data`)  → pg_dump here
#   2. original imported source files (`source-files`) → tar here
#   3. stashed NOMAD upload archives  (`nomad-stash`)  → tar here
#
# A database dump alone is NOT enough: it would leave the imported_source_file
# rows pointing at bytes that no longer exist. Restore all three, in step.
#
# The application is STOPPED for the duration of the snapshot so nothing can
# write to the database or the durable volumes while the dump/tars run — this is
# what keeps the three snapshots mutually consistent.
#
# See AGENTS.md → "Protecting the dev database during tests".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="$ROOT_DIR/db_backups"
mkdir -p "$BACKUP_DIR"

# Quiesce the application — no writes may happen during the snapshot.
echo "[db-backup] stopping the application (backend + frontend)"
docker compose stop backend frontend

# Start only the database (for pg_dump); the app stays stopped.
echo "[db-backup] ensuring db is up"
docker compose up -d --wait db

POSTGRES_USER="$(docker compose exec -T db printenv POSTGRES_USER | tr -d '\r')"
POSTGRES_DB="$(docker compose exec -T db printenv POSTGRES_DB | tr -d '\r')"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/dev-${TIMESTAMP}.sql.gz"
SOURCES="$BACKUP_DIR/source-files-${TIMESTAMP}.tar.gz"
STASH="$BACKUP_DIR/nomad-stash-${TIMESTAMP}.tar.gz"

# 1. PostgreSQL.
echo "[db-backup] dumping database '${POSTGRES_DB}' -> ${DUMP#"$ROOT_DIR"/}"
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    | gzip > "$DUMP"

if [ ! -s "$DUMP" ]; then
    echo "[db-backup] ERROR: dump is empty, aborting so restore cannot clobber data" >&2
    rm -f "$DUMP"
    exit 1
fi
gzip -t "$DUMP" || { echo "[db-backup] ERROR: dump failed gzip validation" >&2; exit 1; }

# 2/3. Durable volumes via a one-off container (the app stays stopped).
echo "[db-backup] archiving source-files -> ${SOURCES#"$ROOT_DIR"/}"
docker compose run --rm --no-deps backend \
    tar -czf - -C /var/lib/plains/source_files . > "$SOURCES"

echo "[db-backup] archiving nomad-stash -> ${STASH#"$ROOT_DIR"/}"
docker compose run --rm --no-deps backend \
    tar -czf - -C /var/lib/plains/nomad_stash . > "$STASH"

# `latest.*` are the pointers db-restore.sh reads.
ln -sf "$(basename "$DUMP")" "$BACKUP_DIR/latest.sql.gz"
ln -sf "$(basename "$SOURCES")" "$BACKUP_DIR/latest-source-files.tar.gz"
ln -sf "$(basename "$STASH")" "$BACKUP_DIR/latest-nomad-stash.tar.gz"

echo "[db-backup] done (db $(du -h "$DUMP" | cut -f1), sources $(du -h "$SOURCES" | cut -f1), stash $(du -h "$STASH" | cut -f1))"
