# Playwright Exploration Testing Plan — Plains

## Overview

Three layers of tests, each building on the last. All go in `frontend/tests/exploration/`.

---

## Layer 1 — Route Smoke Tests (`route-smoke.spec.ts`)

**Goal:** Every authenticated route loads without a crash or console error.

**Logic per route:**
1. Navigate to the route
2. Wait for `networkidle` (AppContext finishes loading all data)
3. Assert no `console.error` or uncaught exceptions were fired
4. Assert the page did not redirect to `/login` (auth held)
5. Take a screenshot (stored as test artifact)

**Routes to cover:**

| Route | Notes |
|---|---|
| `/` | Home / dashboard |
| `/materials` | Materials list |
| `/solutions` | Solutions list |
| `/processes` | Processes list |
| `/experiments` | Experiments list |
| `/results` | Results list |
| `/analysis` | Analysis page |
| `/organization` | Canvas/plane view |
| `/export` | Export page |

---

## Layer 2 — Interactive Crawl (`interactive-crawl.spec.ts`)

**Goal:** Every visible button on every page can be clicked without throwing a JS error.

**Logic per route:**
1. Navigate and wait for `networkidle`
2. Attach `page.on('console')` and `page.on('pageerror')` error collectors
3. Query all `button:visible, [role=button]:visible` elements
4. For each button:
   - Skip buttons whose text matches a destructive blocklist (`/delete|remove|clear/i`) — these are covered in Layer 3
   - Click the button
   - Wait 500 ms (let modals/notifications render)
   - If a Mantine modal appeared, dismiss it via the `×` button or `Escape`
   - If a Mantine notification appeared, let it auto-dismiss
   - Collect any errors fired during this window
5. Assert `errors === []` at the end of each route

**Key helper — modal auto-dismiss:**
```ts
async function dismissOpenModals(page: Page) {
  const closeBtn = page.locator('.mantine-Modal-close:visible').first()
  if (await closeBtn.isVisible()) await closeBtn.click()
  await page.keyboard.press('Escape')
}
```

---

## Layer 3 — CRUD Flow Tests (`crud-flows.spec.ts`)

**Goal:** Create → view → edit → delete for each main entity type without errors.

**One test per entity:** `Material`, `Solution`, `Process`, `Experiment`, `Result`

Each test:
1. Navigate to the entity list page
2. Open the "New …" dialog, fill minimum required fields with fixture data, submit
3. Assert the new item appears in the list
4. Click into the item, assert the detail view loads
5. Edit one field, save, assert the change persisted (re-navigate and verify)
6. Delete the item, assert it disappears from the list

**Fixture data** lives in `tests/exploration/fixtures.ts` — one typed object per entity with valid minimal fields.

---

## Shared Utilities (`helpers.ts`)

```ts
// Error collector — attach at test start, assert at test end
export function attachErrorCollector(page: Page): () => string[] { ... }

// Wait for AppContext to finish hydrating
export async function waitForAppReady(page: Page) {
  await page.waitForLoadState('networkidle')
  // Wait until the sidebar nav links are visible (proxy for full load)
  await page.locator('nav a').first().waitFor({ state: 'visible', timeout: 10_000 })
}

// Get all non-destructive clickable elements on the page
export async function getNonDestructiveButtons(page: Page): Promise<Locator[]> { ... }

// Dismiss any open modal or notification
export async function clearOverlays(page: Page) { ... }
```

---

## File Structure

```
frontend/tests/
├── auth.setup.ts               (existing — reused)
├── config.ts                   (existing — reused)
├── utils/                      (existing)
└── exploration/
    ├── helpers.ts              ← shared utilities
    ├── fixtures.ts             ← test data per entity
    ├── route-smoke.spec.ts
    ├── interactive-crawl.spec.ts
    └── crud-flows.spec.ts
```

All three specs use `storageState: 'playwright/.auth/user.json'` (same pattern as existing tests).

---

## Playwright Config Changes

Add `exploration` as a named project in `playwright.config.ts`:

```ts
{
  name: 'exploration',
  testDir: './tests/exploration',
  use: {
    ...devices['Desktop Chrome'],
    storageState: 'playwright/.auth/user.json',
    video: 'retain-on-failure',
    trace: 'on',
  },
  dependencies: ['setup'],
},
```

---

## Execution

**Prerequisites:** Docker stack must be running (`docker compose watch` or `docker compose up -d`).

```bash
# Run all exploration tests
cd frontend
bunx playwright test --project=exploration

# Run just the smoke layer (fastest, good first check)
bunx playwright test tests/exploration/route-smoke.spec.ts

# Run with visible browser (good for debugging)
bunx playwright test --project=exploration --headed --slowMo=500

# Open the HTML report after a run
bunx playwright show-report
```

The HTML report shows screenshots, traces, and console error logs per test. Clicking into a failed test opens the trace viewer where you can step through exactly which interaction triggered the error.

---

## What This Catches

| Bug type | Caught by |
|---|---|
| Route crashes on load | Layer 1 |
| Unhandled promise rejections from API calls | Layer 1 + 2 |
| Button click throws React error / unmount crash | Layer 2 |
| Modal open/close state corruption | Layer 2 |
| Form validation not blocking invalid submit | Layer 3 |
| Optimistic update not rolling back on API error | Layer 3 |
| Delete cascade leaving orphaned state in AppContext | Layer 3 |
