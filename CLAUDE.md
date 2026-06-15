# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Plains** is a full-stack lab management application for perovskite solar cell research. It tracks the experiment workflow: **Materials → Solutions → Processes/Experiments → Results**, and integrates with [NOMAD](https://nomad-lab.eu/) (Novel Materials Discovery) for uploading research data to external scientific repositories.

The stack is FastAPI (Python) + React (TypeScript) + PostgreSQL, deployed via Docker Compose.

## Commands

### Full Stack (Docker Compose)
```bash
docker compose watch          # Start all services with hot-reload
docker compose logs backend   # Tail a specific service
docker compose exec backend bash  # Shell into running backend container
```

### Backend (from `backend/`)
```bash
uv sync                        # Install dependencies
source .venv/bin/activate      # Activate venv (editors should use backend/.venv/bin/python)
fastapi dev app/main.py        # Run dev server locally (outside Docker)

# Tests
bash ./scripts/test.sh         # Run full test suite with coverage
docker compose exec backend bash scripts/tests-start.sh  # Tests against running stack
docker compose exec backend bash scripts/tests-start.sh -x  # Stop on first failure

# Single test
uv run pytest tests/api/routes/test_users.py -x

# Lint & type-check
bash ./scripts/lint.sh         # mypy + ty + ruff check + ruff format check
```

### Frontend (from `frontend/`)
```bash
bun install
bun run dev                    # Local dev server at http://localhost:5173
bun run lint                   # Biome check + autofix
bun run generate-client        # Regenerate OpenAPI client from openapi.json
bunx playwright test           # E2E tests (requires Docker stack running)
bunx playwright test --ui      # E2E tests with browser UI
```

### Regenerate API Client (full flow)
```bash
bash ./scripts/generate-client.sh  # Runs from project root — generates openapi.json then regenerates frontend client
```

### Database Migrations (inside backend container)
```bash
alembic revision --autogenerate -m "Description"
alembic upgrade head
```

### Pre-commit Hooks
```bash
# Install (run from backend/ with uv)
uv run prek install -f

# Run manually on all files
uv run prek run --all-files
```

## Architecture

### Backend (`backend/app/`)
- `main.py` — FastAPI app setup, CORS, Sentry
- `models.py` — All SQLModel models (DB tables + Pydantic schemas in one file). Every entity has `Base`, `Create`, `Update`, `Public`, and `table=True` variants.
- `crud.py` — Database CRUD helpers
- `api/main.py` — Registers all routers
- `api/routes/` — One file per domain: `materials`, `solutions`, `experiments`, `results`, `planes`, `state`, `nomad`, `users`, `login`
- `api/deps.py` — FastAPI dependency injection (session, current user)
- `core/config.py` — Settings from `.env` via pydantic-settings
- `core/security.py` — JWT and password hashing
- `services/nomad.py` — NOMAD upload integration (zip creation, YAML metadata, API calls)
- `nomad/data_schemas/` — NOMAD archive YAML schemas for measurement types

### Frontend (`frontend/src/`)
- **Auth**: Keycloak SSO via `keycloak-js`. The singleton lives in `lib/keycloakInstance.ts`. Local JWT login also exists (`lib/auth.ts`). The `_gui` route layout enforces authentication via `beforeLoad: ensureAuthenticated`.
- **State**: `store/AppContext.tsx` is the central React context holding all application data (materials, solutions, experiments, results, planes). All mutations flow through a `BackendAdapter` interface.
- **Backend adapter**: `store/backend.ts` defines `BackendAdapter`. `HttpBackend` persists to the FastAPI backend; `InMemoryBackend` keeps data in memory. All data is bulk-loaded on login.
- **Routing**: TanStack Router with file-based routes. `_layout/` routes are the legacy auth layout; `_gui/` routes are the main application (materials, solutions, processes, experiments, results, analysis, organization, export). Run `bun run generate-routes` to regenerate `routeTree.gen.ts` whenever route files are added or moved.
  - Route files are split: `routes/*.page.tsx` are the page components; `routes/_gui/*.tsx` are the thin TanStack Router wrappers that import from the `.page.tsx` counterparts.
- **Path alias**: `@/` resolves to `frontend/src/` (configured in `vite.config.ts`).
- **API client**: `src/client/` is fully generated from `openapi.json` — do not edit manually. Regenerate via `generate-client.sh`.
- **UI**: shadcn/ui (`src/components/ui/`) for base components + Mantine for modals/notifications/dropzone. Tailwind CSS v4.

### Data Model (key entities)
- `Material` — raw chemicals/substrates
- `Solution` — mixtures with composition and solvent details
- `Experiment` — experiment plan with `Substrate`s and `ExperimentLayer`s
- `ExperimentResults` — measurement results (files + device groups) linked to an `Experiment`
- `Plane` + `CanvasElement` — canvas-based organization view (shareable)
- `UserState` — full GUI state persisted as JSONB per user (used for UI preferences/layout)

All primary keys are UUIDs. All entities use cascade deletes. Each entity table has a `frontend_data` JSONB column for flexible UI state.

### NOMAD Integration
NOMAD auth credentials are read from a file outside the project root at `../sensitive config/.nomad_auth`. The backend routes are in `api/routes/nomad.py` and the service logic in `services/nomad.py`. Upload flow: zip measurement files → generate YAML metadata → POST to NOMAD API.

## Development URLs

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Swagger UI | http://localhost:8000/docs |
| Adminer (DB) | http://localhost:8080 |
| Mailcatcher | http://localhost:1080 |
| Traefik UI | http://localhost:8090 |
