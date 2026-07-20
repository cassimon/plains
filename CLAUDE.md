# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Plains** is a full-stack lab management application for perovskite solar cell research. It tracks the experiment workflow: **Materials → Solutions → Processes/Experiments → Results**, and integrates with [NOMAD](https://nomad-lab.eu/) (Novel Materials Discovery) for uploading research data to external scientific repositories.

The stack is FastAPI (Python) + React (TypeScript) + PostgreSQL, deployed via Docker Compose.

## ⚠️ Protecting the dev database during tests

The dev database lives in the `app-db-data` **named volume** (see `compose.yml`). A
normal restart (`docker compose restart` / `stop` + `start` / `up`) reuses that
volume and keeps your data. **The only thing that wipes it is `docker compose
down -v`** — the `-v`/`--volumes` flag deletes the volume.

The test suites (`scripts/test.sh`, `scripts/test-local.sh`) run against the
*same* Compose project and call `down -v`, so historically every test run wiped
the dev database. Those scripts now guard it automatically:

- `scripts/db-backup.sh` `pg_dump`s the dev DB to `db_backups/` (gitignored)
  **before** any `down -v`, updating `db_backups/latest.sql.gz`.
- `scripts/db-restore.sh` drops and rebuilds the DB from that dump **after** the
  run (invoked via a `trap … EXIT`, so it runs even when tests fail).

**Rules to avoid data loss during development:**

- Never run `docker compose down -v` against the dev stack by hand without first
  running `bash scripts/db-backup.sh`. To just stop the stack, use
  `docker compose down` (no `-v`) or `docker compose stop`.
- To rebuild the frontend after a change, use `docker compose up -d --build
  frontend` — it does **not** touch the volume. (The frontend has no hot-reload;
  it is a static nginx build.)
- Any new script or workflow that tears down the stack must back up and restore
  the DB the same way `scripts/test.sh` does (backup first, `trap` restore on
  EXIT), or run against an isolated Compose project/volume.
- `db_backups/` is gitignored — never commit dumps.
- **Never run `pytest` directly against the dev stack.** `down -v` is not the only
  way to lose the dev data: the session-scoped `db` fixture in
  `backend/tests/conftest.py` ends every run with `delete(User)`, and every table
  cascades from `user`, so a bare `uv run pytest` wipes all planes, processes and
  experiments even when every test passes. `scripts/test.sh` is safe because it
  backs up and restores around the run. For quick iteration use an isolated
  database instead — it needs no migration, `init_db` creates the schema:

  ```bash
  docker compose exec -T db psql -U postgres -d postgres -c "CREATE DATABASE app_test;"
  cd backend && POSTGRES_DB=app_test uv run pytest tests/services/test_foo.py -q
  ```

## ⚠️ `git stash` — never pop blind

A real incident in this repo (2026-07): a command of the shape

```bash
git stash push -u -- backend/ && cd backend && <work> ; cd /home/simon/plains && git stash pop
```

was run while the shell was **already** in `backend/`. The pathspec `backend/`
matched nothing, so `git stash push` stashed nothing **and still exited 0**. The
`cd backend` then failed, breaking the `&&` chain — but `git stash pop` was
joined with `;`, so it ran anyway and popped a *pre-existing, unrelated* stash
entry (`recovery-before-checkout`) left over from an older session. That entry
held near-total deletions of 9 files nobody had touched, producing `UU`/`DU`
conflicts with literal `<<<<<<< Updated upstream` markers written into working
files, including a zero-byte `.env`.

**Rules:**

- **Check `git stash list` before any `pop`/`apply`.** This repo can carry stale
  stash entries from previous sessions. Never assume `stash@{0}` is yours; pop
  by explicit ref (`git stash pop stash@{2}`) after reading `git stash show -p`.
- **Only pop if the matching push actually stashed something.** `git stash push`
  with a non-matching pathspec is a silent no-op that exits 0. Verify with
  `git stash list` (or `git rev-parse -q --verify refs/stash`) between push and
  pop — never chain a pop with `;`, and never chain it at all across a `cd`.
- **Confirm `pwd` before any pathspec- or `cd`-relative git command.** The
  session's cwd is `/home/simon/plains/backend`, not the repo root; repo-root
  pathspecs like `backend/` silently match nothing from there. Use absolute
  paths or `git -C /home/simon/plains …`.
- **Prefer a throwaway commit or `git worktree` over stashing** when you need a
  clean tree temporarily — both are named, visible in `git log`/`git worktree
  list`, and cannot be popped onto the wrong state by accident.
- **Never pipe a git command through `| tail -N`** when you care whether it
  worked: the pipeline's exit code is `tail`'s (always 0) and per-file errors
  scroll away. Run it plain, one path at a time, and read the real exit code.
- If conflicts do appear: `git checkout --ours -- <path>` updates the working
  tree but does **not** resolve the index — `git add <path>` afterwards. Verify
  with `git diff --stat HEAD -- <paths>` (empty means recovered) and
  `grep -rl '^<<<<<<<' ` before declaring it fixed. Don't `git stash drop` the
  offending entry without asking — it may be someone's only copy of something.

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
- **Stale-chunk / "blocked MIME type text/html" on navigation**: pages are lazily loaded as hashed chunks (`autoCodeSplitting: true`). When the frontend is rebuilt (`docker compose up -d --build frontend`) while a tab is open, the old tab still requests old chunk hashes (e.g. `results-CM8WUKcq.js`) that no longer exist. nginx's SPA fallback (`try_files $uri /index.html`) returns `index.html` for that `.js` request, the browser blocks the module for its `text/html` MIME type, and the lazy route import throws — surfacing as a broken or "logged out" navigation. **Guard**: `main.tsx` listens for Vite's `vite:preloadError` and reloads once (capped to one auto-reload per 10s via a `sessionStorage` timestamp so a genuinely-missing chunk can't loop). Keep this handler when touching `main.tsx`; any new lazily-imported code inherits the guard automatically.

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

### PDF Export/Import Schema Versioning
Process/Experiment PDFs are editable AcroForm documents that embed a canonical, versioned JSON
serialization of the entity (see `frontend/src/lib/pdfSchema.ts` and the plans in
`docs/plans/process-experiment-pdf-*.md`). This round-trip (export → user edits in a PDF viewer →
import) only works if serialization stays compatible.

**Rule: bump `PDF_SCHEMA_VERSION` in `frontend/src/lib/pdfSchema.ts` whenever the serialized shape
changes** — this includes changes to `Process`/`Experiment` in `AppContext.tsx` that alter what gets
serialized, or to the AcroForm field-name codec. Every bump must add a corresponding entry to the
import migration ladder so older PDFs remain readable (downward compatibility). Never reuse a version
number for a different shape.

## React + Vite + Mantine: Strict Mode Pitfalls

React Strict Mode (active in Vite dev) double-invokes effects and renders. Combined with Mantine hooks (`useMergedRef`, etc.), this creates infinite render loops if not handled carefully. Apply these patterns whenever adding new features to the frontend:

### 1. Never pass inline ref callbacks to Mantine components
Mantine's `useMergedRef` treats a new function reference as a changed ref and re-fires `assignRefs → mergeRefs` on every render, causing an infinite loop. Stabilize ref callbacks with `useMemo`, keyed only on what actually changes (e.g. array length, not contents):

```tsx
// BAD — new function on every render
ref={(node) => { myRefs.current[idx] = node }}

// GOOD — stable per array length
const refCallbacks = React.useMemo(
  () => items.map((_item, idx) => (node: HTMLElement | null) => { myRefs.current[idx] = node }),
  [items.length], // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed only on length
)
```

### 2. Break effect ↔ effect feedback loops with refs
When effect A sets state X and effect B depends on X but also triggers A again, use a ref to read the latest value of X inside effect B without listing X as a dependency. Add an early-exit guard to prevent redundant state updates:

```tsx
const activeEntityRef = useRef(activeEntity)
activeEntityRef.current = activeEntity  // keep in sync on every render

useEffect(() => {
  // Guard: skip if already up-to-date to break the A↔B cycle
  if (activeEntityRef.current?.id === selectedId) return
  setActiveEntity({ kind: "experiment", id: selectedId })
}, [selectedId, setActiveEntity])
```

### 3. Exclude mutated state from effect deps using refs
When an effect reads a value (e.g. `planes`) only to pass it to a mutation (`updateElement`), listing it as a dependency causes the effect to re-run after every mutation. Store it in a ref instead:

```tsx
const planesRef = useRef(planes)
planesRef.current = planes  // kept current on every render

useEffect(() => {
  const plane = planesRef.current.find(...)  // read from ref, not from dep list
  updateElement(...)
}, [/* planes intentionally omitted */])
```

### 4. "Maximum update depth exceeded" in `assignRef → mergeRefs` — read this before debugging

This crash recurred across many sessions (minified as React error #185 in
production). The stack always ends in Mantine ref plumbing and looks like:

```
Error: Maximum update depth exceeded.
    dispatchSetState        ← a useState setter invoked AS a ref
    assignRef / mergeRefs   ← @mantine/hooks useMergedRef
```

**That stack is a red herring.** Mantine's floating components (Select, Popover,
Tooltip, Combobox, ScrollArea) put `useState` setters inside merged refs, so
whichever setState happens to be the 25th nested update — usually a ref
reattach during commit — is where React throws. The *driver* of the storm has
always been in app code.

**Actual root cause (found & fixed 2026-07, `Experiments.page.tsx`): two
effects mirroring the same selection state in both directions.** Effect A
synced `activeEntity` (AppContext) → `selectedExpId` (local); effect B synced
`selectedExpId` → `activeEntity`. Both had "guards" reading the opposite value
through a ref — but a ref mutated during render lags one commit behind the
other effect's write, so with two experiments the pair oscillated A→B→A…
forever, remounting the substrate table each cycle until React threw. That is
why it fired when creating the **second** object (with one object the two
writes converge) and specifically when arriving from another page (Processes →
spawn → /experiments, where `activeEntity` starts out stale/null).

**The rule — one-directional sync only.** Never write the same piece of state
from two effects that watch each other's output, no matter how many ref guards
are added. Pick one source of truth:
- context → local may be an effect (`activeEntity` → `setSelectedExpId`);
- local → context must be *imperative*, in the user-action handler
  (see `selectExperiment()` in `Experiments.page.tsx`), never in an effect.

If you find yourself adding a ref guard so "effect 3" and "effect 4" don't
retrigger each other, delete one of the effects instead — the guard only
shrinks the loop's duty cycle, it does not break the cycle.

**Regression coverage.** `frontend/tests/integration/create-objects-loops.spec.ts`
(real stack) drives create-Experiment-from-Processes ×3 and the File-Upload
picker flow, asserting zero depth-exceeded errors AND that the objects really
persisted (guards against vacuous passes); `frontend/tests/plains-infinite-loops.spec.ts`
covers the mocked-backend routes. Run them after touching Experiments/Processes
pages, `AppLayout`, or `AppContext` selection state. Two test-writing traps
found while building these: (a) the sidebar "Experiments" nav icon is ALSO a
player-play triangle — scope spawn-button locators to `main`; (b) two parallel
browser sessions on one account clobber each other via `syncToBackend`'s
delete-reconciliation — run such tests serially.

**Hardening.** `patches/@mantine%2Fcore@7.17.8.patch` (applied via bun
`patchedDependencies`) stabilizes ScrollArea's internal merged refs, which
Mantine builds with new inline arrows every render — harmless alone, but it
turns any app-level render storm into ref-reattach churn that ends in this
crash. Keep the patch when bumping Mantine (or verify upstream fixed it).

**Related backend gotcha (masked errors).** An unhandled backend exception
returns a 500 *without CORS headers*, so the browser reports it as a CORS
failure ("Access-Control-Allow-Origin missing") and `HttpBackend` sees only
`TypeError: Failed to fetch`. Don't chase CORS config — find the 500 in
`docker compose logs backend`. DB constraint violations are converted to
CORS-visible 409s by the `IntegrityError` handler in `backend/app/main.py`;
register handlers for specific exception types (not bare `Exception`) so
responses pass back through `CORSMiddleware`. Historical instance: the GUI
stores a *process inline-substrate id* in `lab_substrate.substrate_material_id`,
which used to carry a FK to `lab_material` → IntegrityError → masked 500 on
every save. The FK is intentionally gone (dropped in `init_db`); do not
re-add it.

## Development URLs

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Swagger UI | http://localhost:8000/docs |
| Adminer (DB) | http://localhost:8080 |
| Mailcatcher | http://localhost:1080 |
| Traefik UI | http://localhost:8090 |
