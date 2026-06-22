# Task 3: Write & Execute Tests; Fix Bugs (No Functionality Changes)

## Rule
Do NOT add features or change behaviour. Fix bugs discovered by tests only.

## Objective
Achieve meaningful test coverage for both backend (pytest) and frontend (Playwright), then fix any bugs uncovered without altering application behaviour.

---

## Part A — Backend Tests (pytest)

### Current state
- Tests live in `backend/tests/`.
- Run with `bash backend/scripts/test.sh` (spins up a test DB via Docker).

### What to add / improve

1. **Route coverage** (`backend/tests/api/routes/`)
   For every router file in `backend/app/api/routes/` that lacks a test file, create one covering:
   - Happy path (200/201 response, correct payload shape).
   - Auth guard (401 when no token, 403 when wrong role).
   - Not-found (404 when resource doesn't exist).
   - Validation error (422 on bad input).

   Priority order:
   - `materials` — CRUD
   - `solutions` — CRUD
   - `experiments` — CRUD + nested substrate/layer operations
   - `results` — file upload if applicable
   - `nomad` — mock the external API call; test the service layer independently
   - `state` — get/put user state
   - `planes` — CRUD + canvas element operations

2. **CRUD helpers** (`backend/tests/crud/`)
   - Verify cascade deletes work as expected (e.g. deleting a `Solution` removes its dependent records).

3. **Security tests**
   - Add tests that confirm unauthenticated requests to protected routes return 401.
   - Add a test that confirms JWT `algorithm=none` is rejected.

4. **Service tests** (`backend/tests/services/`)
   - `nomad.py`: mock `httpx` and verify zip creation and YAML metadata generation.

### Bug fix process
- Run the full suite: `bash backend/scripts/test.sh`.
- For each failing test that reveals a real bug (not just a missing fixture), diagnose and fix the bug in the source code.
- Do not modify test assertions to make tests pass — fix the code.

---

## Part B — Frontend Tests (Playwright)

### Current state
- Playwright config lives in `frontend/playwright.config.ts` (or similar).
- Tests live in `frontend/tests/`.
- Run with `bunx playwright test` (requires Docker stack running).

### What to write

Create test files in `frontend/tests/` using the Page Object Model pattern where appropriate.

#### Authentication
- `tests/auth.spec.ts`
  - User can reach the login page.
  - Invalid credentials show an error.
  - Valid credentials redirect to the main app.
  - Unauthenticated users are redirected to login when accessing a protected route.

#### Materials
- `tests/materials.spec.ts`
  - Materials list page loads and displays items.
  - Create a new material via the form; verify it appears in the list.
  - Edit an existing material; verify the update is reflected.
  - Delete a material; verify it is removed.

#### Solutions
- `tests/solutions.spec.ts`
  - Same CRUD flow as materials.

#### Experiments / Processes
- `tests/experiments.spec.ts`
  - Create an experiment and add a substrate.
  - Verify the experiment appears in the list.

#### Export
- `tests/export.spec.ts`
  - Navigate to export; verify the page renders without errors.
  - Trigger an export and verify a file download is initiated (or a success toast appears).

#### Navigation & layout
- `tests/navigation.spec.ts`
  - All main nav links resolve to a non-error page.
  - Breadcrumbs / page titles are correct.

### Test helpers
- Use `frontend/tests/utils/` for shared fixtures (login helper, seeded data via API).
- Add a `global-setup.ts` that logs in once and stores auth state for reuse.

### Bug fix process
- Run: `bunx playwright test --reporter=list`.
- For each failure caused by a real bug (broken selector, wrong API call, unhandled error):
  - Fix the source code, not the test.
  - Re-run the specific test to confirm it passes.
  - Do not change test assertions unless the assertion itself is wrong.

---

## Acceptance Criteria
- `bash backend/scripts/test.sh` exits 0 with ≥ 80 % line coverage.
- `bunx playwright test` exits 0 (all written tests pass).
- No test was modified to mask a real bug — all fixes are in source code.
- `bash backend/scripts/lint.sh` and `bun run lint` still pass.
