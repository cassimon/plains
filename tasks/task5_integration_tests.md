# Task 5: Dockerized Full-Stack Integration Tests

## Rule
Do NOT change application behaviour. Add test infrastructure and test code only. Fix bugs uncovered by the tests.

## Objective
Build a hermetic, self-contained integration test suite that spins up the full Docker Compose stack (db, backend, frontend), seeds realistic data via the API, then drives real browser interactions via Playwright — with **zero mocking**. Every test call must hit the live backend and live database. Time is not a constraint; correctness and thoroughness are.

---

## Background & Current State

- **Existing Playwright tests** (`frontend/tests/`) all mock the backend via `page.route()`. They test UI rendering but not actual data persistence, API contract compliance, or end-to-end data flow.
- **Existing pytest tests** (`backend/tests/`) use a test DB via `TestClient` — correct unit/route tests but not full-stack.
- **This task** adds a third test layer: true E2E tests against a running Docker Compose stack, using real HTTP, real PostgreSQL, and a real Vite-built frontend.

---

## Part A — Integration Test Infrastructure

### A-1. Dedicated Compose override for tests

Create `compose.test.yml` at the repo root:

```yaml
# Overrides for integration testing — no hot-reload, no Traefik labels,
# deterministic ports bound to localhost only.
services:
  db:
    ports:
      - "127.0.0.1:5433:5432"   # separate port so it doesn't clash with dev

  backend:
    ports:
      - "127.0.0.1:8001:8000"
    environment:
      - ENVIRONMENT=local
      - EMAILS_ENABLED=false

  frontend:
    ports:
      - "127.0.0.1:5174:80"
```

Run the test stack with:
```bash
docker compose -f compose.yml -f compose.test.yml up -d --build --wait
```

All integration tests must talk to `http://localhost:8001` (API) and `http://localhost:5174` (frontend).

### A-2. Session Start hook (Claude Code on the web)

Create `.claude/hooks/session-start.sh`:
```bash
#!/usr/bin/env bash
# Bring up the integration test stack if not already running.
set -e
cd "$(git rev-parse --show-toplevel)"
if ! docker compose -f compose.yml -f compose.test.yml ps --status running | grep -q backend; then
  docker compose -f compose.yml -f compose.test.yml up -d --build --wait
fi
```
Make it executable (`chmod +x`). This ensures any remote Claude Code session can run integration tests without manual setup.

### A-3. Test environment file

Create `frontend/tests/integration/.env.test`:
```
API_BASE_URL=http://localhost:8001
FRONTEND_BASE_URL=http://localhost:5174
FIRST_SUPERUSER=admin@example.com
FIRST_SUPERUSER_PASSWORD=changethis
```

Values must match `.env.example`. The test runner reads this file; **never hardcode credentials in test files**.

### A-4. Playwright project for integration tests

Add a new project entry in `frontend/playwright.config.ts`:

```ts
{
  name: "integration",
  testDir: "./tests/integration",
  use: {
    baseURL: process.env.FRONTEND_BASE_URL ?? "http://localhost:5174",
    // No storageState — integration tests log in for real.
    // Longer timeouts because we wait for real DB round-trips.
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  // No dependency on the mock auth setup project.
},
```

Run exclusively with:
```bash
cd frontend && bunx playwright test --project=integration
```

### A-5. API client helper for test seeding

Create `frontend/tests/integration/utils/api.ts`:

```ts
// Thin wrapper around fetch for seeding and asserting via the REST API.
// Does NOT go through the browser — direct HTTP from Node.
export async function apiClient(token: string) { ... }
export async function login(email: string, password: string): Promise<string> { ... }
```

The `login` function must call `POST /api/v1/login/access-token`, extract the Bearer token, and return it. All seed helpers (`createMaterial`, `createSolution`, `createProcess`, `createExperiment`, etc.) use this token.

### A-6. Global setup / teardown

Create `frontend/tests/integration/global-setup.ts`:
- Verify the stack is reachable (retry up to 60 s with 2 s backoff — Docker may still be starting).
- Obtain a superuser token and store it in `process.env.INTEGRATION_TOKEN`.
- Create a dedicated test-run user (`integration-{timestamp}@test.plains`) so tests are isolated from the seed superuser.

Create `frontend/tests/integration/global-teardown.ts`:
- Delete the test-run user and all their owned resources.
- Do NOT drop the database — other seed data (superuser, initial plane) must survive.

---

## Part B — Backend API Integration Tests (pytest, live stack)

These are separate from the existing unit tests. They run against the live Docker stack (not `TestClient`).

### Location
`backend/tests/integration/` — new directory, separate from `backend/tests/`.

### B-1. Conftest
`backend/tests/integration/conftest.py`:
- Reads `API_BASE_URL` from env (default `http://localhost:8001`).
- Provides an `httpx.Client` fixture authenticated as the superuser.
- Provides a `test_user_client` fixture that registers a fresh user per test session and cleans up after.

### B-2. Test files to create

| File | What it tests |
|---|---|
| `test_integration_auth.py` | Login → receive JWT; expired/invalid tokens rejected; NOMAD OAuth 400 when disabled |
| `test_integration_materials.py` | Full CRUD cycle: create → read → update → delete; verify DB reflects changes |
| `test_integration_solutions.py` | Full CRUD; verify cascade delete removes `solution_component` rows |
| `test_integration_processes.py` | Create process; add recipes (with solvents/solutes); add steps; add stacks with layers; read back with all nested data; delete cascades |
| `test_integration_experiments.py` | Create experiment linked to a process; attach materials and solutions via junction endpoints; create substrates; read back; verify plane_id propagation |
| `test_integration_results.py` | Create experiment_results; upload a measurement file; verify file metadata is stored; delete experiment → results cascade |
| `test_integration_planes.py` | Create plane; add sticky_note and text_field with integer (i,j) coords; add data_collection; verify canvas integrity; share plane; verify shared user can read but not write |
| `test_integration_analyses.py` | Create analysis linked to multiple results and experiments; verify weak references survive result deletion |
| `test_integration_state.py` | PUT /state/ rejects domain keys (422); PUT /state/ accepts ui_prefs; GET /state/bulk returns all owned domain objects |
| `test_integration_users.py` | Admin can list users; normal user cannot; delete self; verify cascade deletes owned resources |

### B-3. Cascade delete verification pattern

Every resource test must include a cascade delete assertion:
```python
def test_delete_cascades(client, created_process):
    recipe_id = client.post(f"/processes/{created_process}/recipes/", ...).json()["id"]
    client.delete(f"/processes/{created_process}")
    r = client.get(f"/processes/{created_process}/recipes/{recipe_id}")
    assert r.status_code == 404
```

### B-4. IDOR verification pattern

Every resource test must include an ownership assertion:
```python
def test_other_user_cannot_read(user_a_client, user_b_client):
    resource = user_a_client.post("/materials/", json={...}).json()
    r = user_b_client.get(f"/materials/{resource['id']}")
    assert r.status_code == 403
```

---

## Part C — Playwright End-to-End Integration Tests (real browser + real backend)

### Location
`frontend/tests/integration/` — all files here use the `integration` Playwright project (no mocking).

### C-1. Auth flow
`tests/integration/auth.spec.ts`:
- Navigate to `http://localhost:5174` unauthenticated → redirected to `/login`.
- (NOMAD OAuth is not available in test env, so test the local JWT login path if it exists, or skip SSO-only flows with `test.skip`.)
- After auth, `/` loads with the user's planes visible.
- Logout → redirected back to `/login`.

### C-2. Materials end-to-end
`tests/integration/materials.spec.ts`:
- Seed 3 materials via the API before the test.
- Load the materials page → all 3 appear in the list.
- Create a 4th material via the UI form → verify it appears in the list AND verify `GET /api/v1/materials/` returns it.
- Edit the material name via the UI → verify the API reflects the change.
- Delete it via the UI → verify it is gone from both UI and API.

### C-3. Solutions end-to-end
`tests/integration/solutions.spec.ts`:
- Same pattern as materials.
- Additionally: create a solution with two components (material references); verify the components are stored and displayed.

### C-4. Process creation end-to-end
`tests/integration/processes.spec.ts`:
- Create a process via the UI.
- Add a solution recipe (with at least one solvent and one solute) via the UI.
- Add two deposition steps (different stage/step indices) via the UI.
- Add a generated stack with 3 layers via the UI.
- Navigate away and back — verify all sub-resources are still present.
- Verify via the API (`GET /processes/{id}`) that all nested data matches what was entered.

### C-5. Experiment end-to-end
`tests/integration/experiments.spec.ts`:
- Seed a process (with steps) via the API.
- Create an experiment linked to that process via the UI.
- Attach a material and a solution to the experiment.
- Create a substrate and assign an outcome.
- Verify the experiment appears in the plane/collection canvas.

### C-6. Canvas / Plane
`tests/integration/planes.spec.ts`:
- Create a plane.
- Add a sticky note at grid position (2, 3) and verify the (i,j) coordinates are stored correctly (check via API).
- Add a data collection and link an experiment to it.
- Verify that moving a sticky note to a new position (5, 1) updates `i` and `j` in the DB.
- Verify collections are always 1×1 (API rejects non-unit extent).

### C-7. NOMAD upload flow (mocked external only)
`tests/integration/nomad.spec.ts`:
- Set `NOMAD_MOCK_MODE=true` in the test environment.
- Create an experiment with results.
- Trigger the NOMAD upload via the UI.
- Verify the UI shows a success state.
- Verify the backend stored a `nomad_upload_id` on the `experiment_results` row.

### C-8. Data persistence across browser sessions
`tests/integration/persistence.spec.ts`:
- Create a material in one browser context.
- Open a new browser context (new session, fresh cookies, re-login).
- Verify the material is still present in the list.
- This test catches bugs where data is only held in frontend state and not actually persisted to the DB.

---

## Part D — CI Integration

### D-1. GitHub Actions workflow

Create `.github/workflows/integration-tests.yml`:

```yaml
name: Integration Tests

on:
  push:
    branches: [main, "claude/*"]
  pull_request:
    branches: [main]

jobs:
  integration:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - name: Copy env
        run: cp .env.example .env

      - name: Build and start stack
        run: |
          docker compose -f compose.yml -f compose.test.yml up -d --build --wait
          # Wait for prestart (migrations + seed) to complete
          docker compose logs prestart

      - name: Run backend integration tests
        run: |
          docker compose exec -T backend \
            bash -c "API_BASE_URL=http://localhost:8000 uv run pytest tests/integration/ -v"

      - name: Install Playwright browsers
        run: cd frontend && bun install && bunx playwright install --with-deps chromium

      - name: Run Playwright integration tests
        env:
          FRONTEND_BASE_URL: http://localhost:5174
          API_BASE_URL: http://localhost:8001
          FIRST_SUPERUSER: ${{ secrets.FIRST_SUPERUSER || 'admin@example.com' }}
          FIRST_SUPERUSER_PASSWORD: ${{ secrets.FIRST_SUPERUSER_PASSWORD || 'changethis' }}
        run: cd frontend && bunx playwright test --project=integration --reporter=list

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: frontend/playwright-report/

      - name: Tear down stack
        if: always()
        run: docker compose -f compose.yml -f compose.test.yml down -v
```

### D-2. `.env.example` completeness

Verify that `.env.example` contains every variable consumed by `compose.test.yml` and the integration test helpers. Add any missing variables with safe placeholder values.

---

## Acceptance Criteria

| Criterion | Check |
|---|---|
| `compose.test.yml` exists and `docker compose -f compose.yml -f compose.test.yml up --wait` exits 0 | Manual / CI |
| `uv run pytest tests/integration/ -v` exits 0 (all backend integration tests pass) | CI |
| `bunx playwright test --project=integration` exits 0 (all Playwright integration tests pass) | CI |
| Every test in Part B covers happy path + cascade delete + IDOR | Code review |
| Every test in Part C makes at least one real API assertion (no pure-UI mocks) | Code review |
| `.github/workflows/integration-tests.yml` exists and the workflow is green on the branch | GitHub Actions |
| No existing unit tests broken (`uv run pytest tests/` still passes, `bunx playwright test --project=chromium` still passes) | CI |
| No application source code changed (only test files, compose override, CI workflow, session hook) | `git diff --stat` |

---

## Notes

- **Time**: Budget ~4 hours of AI execution time. Do not cut corners on cascade delete and IDOR coverage — these are the most valuable checks.
- **Flakiness**: If a test is flaky, diagnose the root cause (timing, missing wait, real race condition) and fix it. Do not add `test.setTimeout(60_000)` or `waitForTimeout` as a band-aid.
- **Secrets**: Never commit real credentials. The CI workflow uses GitHub Secrets with `.env.example` fallbacks only for local dev convenience.
- **Data isolation**: Each test must create its own data and clean it up. Never depend on data left by another test. Use unique names with a timestamp or `uuid` suffix.
- **Browser**: Use Chromium only for integration tests (single browser keeps CI fast without sacrificing coverage — the integration layer tests logic, not browser compatibility).
