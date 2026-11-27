# Operations, development and maintenance

This document covers running, developing, testing, backing up and extending Plains. It is a
reference; the safety rules in [AGENTS.md](../AGENTS.md) take precedence.

## Development

### Backend (from `backend/`)

```bash
uv sync                          # install dependencies
source .venv/bin/activate        # editors should use backend/.venv/bin/python
fastapi dev app/main.py          # local dev server (outside Docker)

bash ./scripts/test.sh           # full test suite with coverage
bash ./scripts/lint.sh           # mypy + ty + ruff check + ruff format check
uv run pytest tests/api/routes/test_users.py -x   # single test
```

### Frontend (from `frontend/`)

```bash
bun install
bun run dev                      # local dev server at http://localhost:5173
bun run lint                     # Biome check + autofix
bun run generate-client          # regenerate the OpenAPI client from openapi.json
bunx playwright test             # E2E tests (requires the Docker stack)
```

### Regenerate the API client

```bash
bash ./scripts/generate-client.sh   # from the repo root
```

### Pre-commit

```bash
cd backend && uv run prek install -f
uv run prek run --all-files
```

## Docker configuration

`compose.yml` defines the full stack (frontend, backend, db, adminer, mailcatcher, traefik).
Overrides specialize environments: `compose.prod.yml` (production), `compose.test.yml`
(integration tests — no Traefik, deterministic localhost ports, mock NOMAD, JWT test auth),
`compose.override.yml`, `compose.traefik.yml`, `compose.localproxy.yml`.

Durable named volumes:

| Volume | Contents |
|---|---|
| `app-db-data` | PostgreSQL data. |
| `source-files` | Original imported measurement bytes (`/var/lib/plains/source_files`). |
| `nomad-stash` | Temporary and failed-upload archives (`/var/lib/plains/nomad_stash`). |

The frontend image is a static nginx build with no hot reload. Rebuild it with
`docker compose up -d --build frontend` (this does not touch the database volume).

## Test isolation — protecting the database

The test suites run against the same Compose project and historically called `down -v`, which
wipes the `app-db-data` volume. The scripts now guard it:

- `scripts/db-backup.sh` `pg_dump`s the database and tars the durable volumes to `db_backups/`
  before any `down -v`, updating `db_backups/latest.*`.
- `scripts/db-restore.sh` drops and rebuilds the database and restores the volumes from that
  dump (invoked via a `trap … EXIT`, so it runs even when tests fail).

Safety rules:

- Never run `docker compose down -v` by hand without `bash scripts/db-backup.sh` first. To just
  stop the stack use `docker compose down` (no `-v`) or `docker compose stop`.
- Never run `pytest` directly against the dev stack: the session-scoped `db` fixture ends with
  `delete(User)`, and every table cascades from `user`, wiping all data. Use an isolated
  database instead (no migration needed — `init_db` creates the schema):

  ```bash
  docker compose exec -T db psql -U postgres -d postgres -c "CREATE DATABASE app_test;"
  cd backend && POSTGRES_DB=app_test uv run pytest tests/services/test_foo.py -q
  ```

- `db_backups/` is gitignored — never commit dumps.

## Backup and restore

`scripts/db-backup.sh` and `scripts/db-restore.sh` back up and restore **three** things together:
the PostgreSQL database, the `source-files` volume and the `nomad-stash` volume. A database dump
alone is insufficient — it would leave `imported_source_file` rows pointing at bytes that no
longer exist.

- Backup stops the app, `pg_dump`s the database, tars both volumes, and writes `latest.*`
  symlinks.
- Restore validates the complete matching set (present, non-empty, gzip/tar-readable) **before**
  anything destructive, stops the app, drops and recreates the database, then restores both
  volumes.

See the scripts themselves and [AGENTS.md](../AGENTS.md) for the full procedure.

## Maintenance and extension

- **Data model**: models live in one file, `backend/app/models.py`. New columns on existing
  deployments must be added to the `init_db` block in `backend/app/core/db.py` (the schema is
  not managed by Alembic — see [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Frontend routes**: file-based TanStack Router. After adding/moving a route, run
  `bun run generate-routes`. Route files are split into `*.page.tsx` (the component) and thin
  `_gui/*.tsx` wrappers.
- **API client**: `frontend/src/client/` is generated from `openapi.json`; regenerate with
  `scripts/generate-client.sh` rather than editing it.
- **PDF round-trip**: Process/Experiment PDFs embed a versioned JSON serialization. Bump
  `PDF_SCHEMA_VERSION` in `frontend/src/lib/pdfSchema.ts` whenever the serialized shape changes,
  and add a migration so older PDFs stay readable.
- **UI**: two systems coexist (Mantine in the scientific `_gui` area, shadcn/ui + Tailwind in
  `_layout`/auth). Follow [UI_GUIDELINES.md](UI_GUIDELINES.md) — do not mix them within a
  screen, and do not add new UI libraries.
- **React Strict Mode**: Mantine + Strict Mode can cause render loops. Follow the patterns in
  [AGENTS.md](../AGENTS.md) (stable ref callbacks, one-directional state sync).
- **Non-regression**: every change must preserve existing functionality and research data. See
  the non-regression policy in [AGENTS.md](../AGENTS.md) before implementing.
