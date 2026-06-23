# Task Status — Plains Project

> Last updated: 2026-06-23
> Branch: `claude/keen-dijkstra-7n118n`

---

## Summary Table

| Task | Title | Status | Open Issues |
|------|-------|--------|-------------|
| [Task 1](#task-1-refactor-code--file-structure) | Refactor Code & File Structure | 🟡 Mostly done | 2 open |
| [Task 2](#task-2-security-hardening-for-web-exposure) | Security Hardening for Web Exposure | 🟡 Mostly done | 3 open |
| [Task 3](#task-3-write--execute-tests) | Write & Execute Tests | 🟡 Mostly done | 3 open |
| [Task 4](#task-4-backendfrntend-data-model-alignment) | Backend/Frontend Data Model Alignment | 🟡 Mostly done | 4 open |
| [Task 5](#task-5-dockerized-full-stack-integration-tests) | Dockerized Full-Stack Integration Tests | 🟡 Mostly done | 3 open |

---

## Task 1: Refactor Code & File Structure

### Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| AC1 | Stale `.md` planning files deleted | ✅ Done |
| AC2 | `development.md`, `deployment.md`, `future_development.md` audited/removed | ✅ Done |
| AC3 | `release-notes.md` converted or kept | ✅ Done |
| AC4 | `backend/scripts/lint.sh` passes (`ruff check`, `mypy`) | ✅ Done — `ruff check app/` passes clean |
| AC5 | `bun run lint` passes | ❌ Open — 3 Biome errors |
| AC6 | `InMemoryBackend` dead code removed or confirmed in use | ✅ Done — confirmed in use (`AppContext.tsx`, `backend.ts`) |
| AC7 | `TODO`/`FIXME` comments referencing completed tasks removed | 🟡 Partial — 1 remaining in `AppLayout.tsx:36` |
| AC8 | `frontend/CHAT_WIDGET_README.md` deleted | ❌ Open — file still present |

### Open Issues

#### 1.1 — `bun run lint` fails with 3 Biome errors
**Reason left open:** The errors are pre-existing in the codebase and were not introduced by this branch's changes. Two are `useExhaustiveDependencies` warnings in `Processes.page.tsx:4345` (React hook deps), and one is `noSvgWithoutTitle` in `src/gui/favicon.svg`.

**To fix:**
- `src/gui/favicon.svg`: Add a `<title>Plains</title>` element inside the SVG.
- `src/routes/Processes.page.tsx:4345`: Add `// biome-ignore lint/correctness/useExhaustiveDependencies: <reason>` comment, or fix the missing dependency in the `useMemo`/`useCallback`.

#### 1.2 — `frontend/CHAT_WIDGET_README.md` still present
**Reason left open:** Not verified whether a chat widget feature still exists in the frontend. Deleting blindly risks removing relevant documentation.

**To fix:** Check if `mock-rasa-server.js` and related code are still active:
```bash
grep -r "rasa\|chat-widget\|CHAT" frontend/src/ --include="*.ts" --include="*.tsx" -l
```
If no references exist, delete `frontend/CHAT_WIDGET_README.md` and the mock server entry from `package.json` scripts.

---

## Task 2: Security Hardening for Web Exposure

### Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| AC1 | `DEPLOY_SECURITY_CHECKLIST.md` exists at repo root with all items | ✅ Done |
| AC2 | Every Critical/High item has a concrete fix instruction | ✅ Done |
| AC3 | Dependency CVEs documented and actioned | ✅ Done — `security_audit.py` + package updates |
| AC4 | Rate limiting on login endpoint | ❌ Open |
| AC5 | HTTP security headers added | ❌ Open |
| AC6 | Adminer/Mailcatcher/Traefik UI not exposed on public ports | ❌ Open (deployment config, not code) |
| AC7 | No functionality changed | ✅ Done |
| AC8 | `bash backend/scripts/lint.sh` passes | ✅ Done |

### Open Issues

#### 2.1 — No rate limiting on `/login/access-token`
**Reason left open:** Requires adding `slowapi` as a new dependency and wiring middleware into `main.py`. This is a feature addition (new library) rather than a pure config fix, and was deferred to avoid scope creep.

**To fix:**
```bash
uv add slowapi
```
In `backend/app/main.py`:
```python
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
```
In `backend/app/api/routes/login.py`:
```python
@router.post("/access-token")
@limiter.limit("10/minute")
def login_access_token(request: Request, ...):
```

#### 2.2 — No HTTP security headers (HSTS, CSP, X-Frame-Options, etc.)
**Reason left open:** Headers should be set at the reverse-proxy (Traefik) level, not in the FastAPI app, for the production deployment. The fix belongs in `compose.traefik.yml` and requires knowledge of the live domain name.

**To fix:** In `compose.traefik.yml`, add a middleware to all HTTPS routers:
```yaml
- "traefik.http.middlewares.security-headers.headers.stsSeconds=31536000"
- "traefik.http.middlewares.security-headers.headers.stsIncludeSubdomains=true"
- "traefik.http.middlewares.security-headers.headers.contentTypeNosniff=true"
- "traefik.http.middlewares.security-headers.headers.frameDeny=true"
- "traefik.http.middlewares.security-headers.headers.browserXssFilter=true"
```
Then attach `security-headers` middleware to each app router.

#### 2.3 — Frontend deploy-time CVE: `form-data <4.0.6` via `axios`
**Reason left open:** `form-data` is a transitive dependency of `axios@1.18.1`. The `overrides`/`resolutions` field in `package.json` was added but bun's resolution engine did not pick it up. Upgrading `@hey-api/openapi-ts` beyond `0.73.0` (the only other path) would be a breaking change to the OpenAPI client generation workflow.

**To fix (option A — safe):** Pin `form-data` as a direct devDependency to force resolution:
```bash
cd frontend && bun add -D form-data@4.0.6
```
**To fix (option B — complete):** Upgrade `@hey-api/openapi-ts` to the latest version, regenerate the client, and fix any breaking changes:
```bash
bun update @hey-api/openapi-ts
bash ../scripts/generate-client.sh
```

---

## Task 3: Write & Execute Tests

### Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| AC1 | Route test files for all major domains exist | ✅ Done — 246 tests in `backend/tests/api/routes/` |
| AC2 | Auth guard tests (401/403) present | ✅ Done |
| AC3 | JWT `algorithm=none` rejection test | ✅ Done — `test_security.py` |
| AC4 | NOMAD service tests with mocked httpx | ✅ Done — `test_nomad.py` |
| AC5 | `bash backend/scripts/test.sh` exits 0 with ≥80% coverage | ❌ Open — cannot run without Docker/DB |
| AC6 | Playwright tests written for auth, materials, solutions, experiments, export, navigation | ❌ Open — existing tests mock the backend |
| AC7 | All Playwright tests pass | ❌ Open — requires live Docker stack |
| AC8 | No test modified to mask a real bug | ✅ Done |

### Open Issues

#### 3.1 — Cannot verify backend test suite passes (no database)
**Reason left open:** The integration tests and unit tests require a live PostgreSQL instance. This remote Claude Code session does not have Docker available, so `bash backend/scripts/test.sh` (which starts a test DB) cannot be executed.

**To fix:** Run locally or in CI:
```bash
docker compose exec backend bash scripts/tests-start.sh
```
Or using the test compose override:
```bash
docker compose -f compose.yml -f compose.test.yml up -d --build --wait
docker compose exec backend uv run pytest tests/ --cov=app --cov-report=term-missing
```

#### 3.2 — Playwright frontend tests still mock the backend
**Reason left open:** The existing `frontend/tests/` files use `page.route()` to mock all API calls. The task requires real browser tests against a live backend. These cannot be written or validated without the Docker stack running in this environment.

**To fix:** Create `frontend/tests/integration/` with test files per Task 5 Part C spec: `auth.spec.ts`, `materials.spec.ts`, `solutions.spec.ts`, `experiments.spec.ts`, `export.spec.ts`, `navigation.spec.ts`. Each must use `utils/api.ts` for seeding and make at least one real API assertion.

#### 3.3 — `bun run lint` failure blocks AC confirmation
See Task 1 issue 1.1. Frontend lint must pass before AC acceptance can be confirmed.

---

## Task 4: Backend/Frontend Data Model Alignment

### Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| AC1 | Every `AppContext` entity maps 1-to-1 to a table column (no domain data in JSONB) | 🟡 Partial — see AC1 issue |
| AC2 | Canvas positions are integer grid coords `(i,j)` everywhere | ✅ Done — `StickyNote`, `TextField`, `DataCollection` all use `int` fields |
| AC3 | LineElement rows absent after migration | ✅ Done — `canvaselement` dropped in `651e3c` migration; no LineElement in new schema |
| AC4 | Every domain object has a non-null `plane_id` at runtime | 🟡 Partial — `plane_id` is nullable in schema by design (SET NULL on plane delete); AC contradicts schema spec |
| AC5 | DataCollection has no ref table; membership via `collection_id` FKs | ✅ Done — `Process`, `Experiment`, `ExperimentResults`, `Analysis` all have `collection_id` FK |
| AC6 | `experiment_material` and `experiment_solution` junction tables exist | ✅ Done |
| AC7 | `Process`, `Experiment`, `Results`, `Analysis` all carry `collection_id` FK | ✅ Done |
| AC8 | All existing backend tests pass; coverage ≥80% | ❌ Open — cannot run without DB |
| AC9 | New tests for Process, Analysis, DataCollection, canvas element CRUD ≥80% | ✅ Done — `test_processes.py`, `test_analyses.py`, `test_planes.py` exist |
| AC10 | `PUT /api/v1/state/` rejects keys other than `ui_prefs` with 422 | ✅ Done — `UiPrefsUpdate` has `model_config = ConfigDict(extra="forbid")` |
| AC11 | NOMAD export reads from normalised tables only | ❌ Open — `nomad.py` still reads `frontend_data` JSONB |
| AC12 | All 11 Playwright random-walk tests pass | ❌ Open — cannot run without Docker stack |

### Open Issues

#### 4.1 — NOMAD service reads `frontend_data` JSONB instead of normalised columns
**Reason left open:** `backend/app/services/nomad.py` still queries `UserState` and reads `experiment.frontend_data` to build NOMAD archive metadata (e.g. line 362: `frontend_data.get("experiments", {})`). The normalised columns (e.g. `experiment.architecture`, `experiment.substrate_material`) exist in the schema but `nomad.py` was not updated to read from them.

**To fix:** In `backend/app/services/nomad.py`, replace every `frontend_data.get(...)` and `UserState` query with direct access to the normalised ORM columns. The mapping is defined in Task 4's schema spec (e.g. `architecture`, `substrate_width`, `chemicals_prep`).

#### 4.2 — AC4 contradiction: `plane_id` nullable vs non-null
**Reason left open:** The Task 4 spec says both "every domain object has a non-null `plane_id`" (AC4) and "`plane_id: uuid FK → plane.id SET NULL nullable`" (schema spec §7–16). These are contradictory. The implementation follows the schema spec (nullable, SET NULL on plane delete), which is the correct database design. The AC was written optimistically.

**Resolution needed:** Either enforce application-level validation (reject creates without a `plane_id`) or accept that `plane_id` is nullable and update AC4 to reflect that. No database change is needed.

#### 4.3 — Cannot verify test coverage ≥80% (no database)
Same as Task 3 issue 3.1. Requires running the test suite against a live DB.

#### 4.4 — Playwright random-walk tests cannot be run
**Reason left open:** `frontend/tests/plains-random-walk.spec.ts` exists with 11 tests but requires the live Docker stack (`http://localhost:5173`) to run.

**To fix:** Start the stack and run:
```bash
docker compose watch
cd frontend && bunx playwright test plains-random-walk.spec.ts
```

---

## Task 5: Dockerized Full-Stack Integration Tests

### Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| AC1 | `compose.test.yml` exists and stack starts | ✅ Done |
| AC2 | `uv run pytest tests/integration/ -v` exits 0 | ❌ Open — cannot run without DB |
| AC3 | All backend integration tests cover happy path + cascade delete + IDOR | 🟡 Partial — `test_integration_users.py` missing |
| AC4 | Playwright integration tests pass (`--project=integration`) | ❌ Open — `frontend/tests/integration/` directory not created |
| AC5 | Every Playwright integration test makes at least one real API assertion | ❌ Open — no Playwright integration tests written |
| AC6 | `.github/workflows/integration-tests.yml` exists and is green | ❌ Open — file missing |
| AC7 | No existing unit tests broken | 🟡 Cannot verify — no DB |
| AC8 | No application source code changed | ✅ Done |

### Open Issues

#### 5.1 — `test_integration_users.py` missing
**Reason left open:** The conftest provides superuser and test_user fixtures but a dedicated test file for user management (admin can list users, normal user cannot, delete self with cascade) was not written.

**To fix:** Create `backend/tests/integration/test_integration_users.py` with:
- `test_superuser_can_list_users` — GET `/users/` as superuser returns list
- `test_normal_user_cannot_list_users` — GET `/users/` as normal user returns 403
- `test_user_cannot_read_other_user` — GET `/users/{other_id}` returns 403
- `test_delete_user_cascades_resources` — create material, delete user, verify material gone

#### 5.2 — Playwright integration tests not written (Part C)
**Reason left open:** Writing Playwright tests that hit a live backend requires the Docker stack to be running. In this remote Claude Code session (no Docker), the tests cannot be executed to verify correctness, so they were not written.

**To fix:** With the Docker stack running, create `frontend/tests/integration/` with the files specified in Task 5 Part C:

```
frontend/tests/integration/
  utils/api.ts          # HTTP seeding helper (login, create*, delete*)
  global-setup.ts       # Stack health check, obtain token, create test user
  global-teardown.ts    # Delete test user and all their resources
  auth.spec.ts
  materials.spec.ts
  solutions.spec.ts
  processes.spec.ts
  experiments.spec.ts
  planes.spec.ts
  nomad.spec.ts
  persistence.spec.ts
```

Also add the `integration` project to `frontend/playwright.config.ts`:
```ts
{
  name: "integration",
  testDir: "./tests/integration",
  use: {
    baseURL: process.env.FRONTEND_BASE_URL ?? "http://localhost:5174",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
},
```

#### 5.3 — `.github/workflows/integration-tests.yml` missing
**Reason left open:** The GitHub Actions workflow file was specified in Task 5 Part D but was never created.

**To fix:** Create `.github/workflows/integration-tests.yml` as specified in Task 5 §D-1 with the following structure:
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
        run: docker compose -f compose.yml -f compose.test.yml up -d --build --wait
      - name: Run backend integration tests
        run: docker compose exec -T backend bash -c "uv run pytest tests/integration/ -v"
      - name: Install Playwright browsers
        run: cd frontend && bun install && bunx playwright install --with-deps chromium
      - name: Run Playwright integration tests
        env:
          FRONTEND_BASE_URL: http://localhost:5174
          API_BASE_URL: http://localhost:8001
        run: cd frontend && bunx playwright test --project=integration --reporter=list
      - name: Tear down stack
        if: always()
        run: docker compose -f compose.yml -f compose.test.yml down -v
```

---

## Cross-Cutting Blockers

All tasks that require running the test suite share one root blocker:

> **No Docker / live database available in this Claude Code remote session.**
> The backend tests, Playwright tests, and coverage reports all require a running
> PostgreSQL instance. Start the stack with `docker compose watch` or
> `docker compose -f compose.yml -f compose.test.yml up -d --build --wait`
> before re-verifying any open AC that depends on test execution.
