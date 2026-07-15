#! /usr/bin/env bash

# Exit in case of error
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# This suite runs against the dev Compose project and calls `down -v`, which
# deletes the dev database volume. Snapshot it first and guarantee it is
# reinstated no matter how the run exits. See CLAUDE.md → "Protecting the dev
# database during tests".
bash "$SCRIPT_DIR/db-backup.sh"
trap 'bash "$SCRIPT_DIR/db-restore.sh"' EXIT

docker-compose down -v --remove-orphans # Remove possibly previous broken stacks left hanging after an error

if [ $(uname -s) = "Linux" ]; then
    echo "Remove __pycache__ files"
    sudo find . -type d -name __pycache__ -exec rm -r {} \+
fi

docker-compose build
docker-compose up -d
docker-compose exec -T backend bash scripts/tests-start.sh "$@"
