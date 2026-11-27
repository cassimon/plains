#! /usr/bin/env bash

# Isolated full-stack test run.
#
# Runs the backend unit/route suite against a dedicated Compose *project*
# (`plains-test` by default), so the `down -v` teardown below only ever removes
# the isolated test volumes — never the development database (`app-db-data`) or
# the durable `source-files` / `nomad-stash` volumes. See AGENTS.md →
# "Protecting the dev database during tests" and the source-files note.
#
# Uses the same `compose.test.yml` overlay as CI (mock NOMAD, local JWT auth,
# deterministic localhost ports).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Dedicated test project, selected explicitly with `-p` so an inherited
# COMPOSE_PROJECT_NAME can never redirect `down -v` at development volumes.
COMPOSE=(docker compose -p plains-test -f compose.yml -f compose.test.yml)

"${COMPOSE[@]}" build
"${COMPOSE[@]}" down -v --remove-orphans   # only the isolated test project
"${COMPOSE[@]}" up -d --wait
"${COMPOSE[@]}" exec -T backend bash scripts/tests-start.sh "$@"
"${COMPOSE[@]}" down -v --remove-orphans
