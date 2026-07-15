#! /usr/bin/env bash
#
# Snapshot the local development database before a destructive test run.
#
# The test scripts run against the *same* Docker Compose project (and therefore
# the same `app-db-data` volume) as development, and they call
# `docker compose down -v`, which deletes that volume. This script dumps the dev
# database to a gitignored file first so `scripts/db-restore.sh` can put it back.
#
# See CLAUDE.md → "Protecting the dev database during tests".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="$ROOT_DIR/db_backups"
mkdir -p "$BACKUP_DIR"

# pg_dump needs the db running. `up -d --wait` is a no-op if it is already up,
# and otherwise starts just the db service and blocks until its healthcheck
# passes. We only touch the db service so no other containers are disturbed.
echo "[db-backup] ensuring db service is up"
docker compose up -d --wait db

# Read the real credentials/db name straight from the running container's
# environment so we never have to parse .env on the host.
POSTGRES_USER="$(docker compose exec -T db printenv POSTGRES_USER | tr -d '\r')"
POSTGRES_DB="$(docker compose exec -T db printenv POSTGRES_DB | tr -d '\r')"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/dev-${TIMESTAMP}.sql.gz"

echo "[db-backup] dumping database '${POSTGRES_DB}' -> ${DUMP#"$ROOT_DIR"/}"
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    | gzip > "$DUMP"

# Fail loudly (and keep no bogus "latest") if the dump came out empty.
if [ ! -s "$DUMP" ]; then
    echo "[db-backup] ERROR: dump is empty, aborting so restore cannot clobber data" >&2
    rm -f "$DUMP"
    exit 1
fi

# `latest.sql.gz` is the pointer db-restore.sh reads.
ln -sf "$(basename "$DUMP")" "$BACKUP_DIR/latest.sql.gz"

echo "[db-backup] done ($(du -h "$DUMP" | cut -f1))"
