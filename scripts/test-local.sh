#! /usr/bin/env bash

# Isolated full-stack test run (local variant).
#
# Same isolation contract as scripts/test.sh: a dedicated Compose project so the
# `down -v` teardown never touches the development database or the durable
# source-files / nomad-stash volumes. See AGENTS.md and scripts/test.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Dedicated test project, selected explicitly with `-p` so an inherited
# COMPOSE_PROJECT_NAME can never redirect `down -v` at development volumes.
COMPOSE=(docker compose -p plains-test -f compose.yml -f compose.test.yml)

"${COMPOSE[@]}" down -v --remove-orphans   # only the isolated test project

if [ "$(uname -s)" = "Linux" ]; then
    echo "Remove __pycache__ files"
    find . -type d -name __pycache__ -exec rm -r {} + 2>/dev/null || true
fi

"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d --wait
"${COMPOSE[@]}" exec -T backend bash scripts/tests-start.sh "$@"
