#!/usr/bin/env bash

set -e
set -x

# tests/integration/ drives a live Docker stack over HTTP (port 8001) and is run
# separately in CI (`pytest tests/integration/`); exclude it from the unit/route
# suite so this script can run without the full stack up.
coverage run -m pytest tests/ --ignore=tests/integration
coverage report
coverage html --title "${@-coverage}"
