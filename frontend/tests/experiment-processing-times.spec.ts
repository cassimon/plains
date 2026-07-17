/**
 * The Processing tab's "End of experiment" cell, and the Summary tab's derived
 * start/end.
 *
 * The end cell is what gives the last deposition step a duration when the
 * experiment is uploaded to NOMAD (see backend/app/services/nomad.py) — so it
 * must exist, be editable, and drive the Summary's read-only start/end.
 */

import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"

const PROC_ID = "11111111-1111-1111-1111-111111111111"
const EXP_ID = "22222222-2222-2222-2222-222222222222"

// `/state/bulk` speaks the API's snake_case shape (see backendMapping.ts), not
// the in-app camelCase one.
const process = {
  id: PROC_ID,
  name: "Baseline",
  description: "",
  collection_id: null,
  steps: [
    {
      id: "s0",
      stage_index: 0,
      name: "Clean",
      step_category: "substrate_preparation",
      color: "#aaa",
    },
    {
      id: "s1",
      stage_index: 1,
      name: "Perovskite",
      step_category: "wet_deposition",
      color: "#bbb",
    },
  ],
  generated_stacks: [],
}

const experiment = {
  id: EXP_ID,
  name: "TimingExp",
  description: "intent",
  date: null,
  end_date: null,
  collection_id: null,
  architecture: "n-i-p",
  substrate_material: "glass",
  substrate_width: 2.5,
  substrate_length: 2.5,
  num_substrates: 1,
  devices_per_substrate: 4,
  device_area: 0.16,
  device_type: "full",
  process_id: PROC_ID,
  substrates: [{ id: "sub-1", name: "sub-1", parameter_values: {} }],
  processing_times: {},
  has_results: false,
}

async function mockApi(page: Page): Promise<void> {
  const state = {
    materials: [],
    solutions: [],
    experiments: [experiment],
    results: [],
    planes: [],
    processes: [process],
  }
  await page.route("**/api/v1/users/me", (route) =>
    route.fulfill({
      status: 200,
      json: {
        id: "00000000-0000-0000-0000-000000000001",
        email: "test@plains.dev",
        is_active: true,
        is_superuser: false,
        full_name: "Test User",
      },
    }),
  )
  await page.route("**/api/v1/state/bulk", (route) =>
    route.fulfill({ status: 200, json: state }),
  )
  await page.route("**/api/v1/state/", (route) =>
    route.fulfill({ status: 200, json: { data: state } }),
  )
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 200, json: {} }),
  )
}

/** Navigate, inject mock Keycloak so the auth guard passes, and open Step 2. */
async function openProcessingTab(page: Page): Promise<void> {
  await mockApi(page)
  await page.goto("/experiments", { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => "__plains_setKeycloak" in window, {
    timeout: 10_000,
  })
  await page.evaluate(() => {
    ;(
      window as unknown as { __plains_setKeycloak: (kc: unknown) => void }
    ).__plains_setKeycloak({
      authenticated: true,
      token: "mock-token",
      updateToken: () => Promise.resolve(true),
      onTokenExpired: undefined,
      logout: () => {},
    })
  })
  await page.getByText("TimingExp", { exact: true }).first().click()
  // The guided steps are clickable boxes ("Step 2" / "Processing"), not tabs.
  await page.getByText("Processing", { exact: true }).first().click()
}

test("Processing tab has an end-of-experiment cell that drives the Summary's start/end", async ({
  page,
}) => {
  await openProcessingTab(page)

  // The table has one column per step, then the end-of-experiment column.
  const table = page
    .locator("main table")
    .filter({ hasText: "Processing Times" })
  await expect(table.locator("th", { hasText: "#1 Step" })).toBeVisible()
  await expect(table.locator("th", { hasText: "#2 Step" })).toBeVisible()
  await expect(
    table.locator("th", { hasText: "End of experiment" }),
  ).toBeVisible()

  const row = table.locator("tr", { hasText: "Processing Times" })
  const dates = row.locator('input[type="date"]')
  const times = row.locator('input[type="time"]')
  // Three cells: step 1, step 2, end of experiment.
  await expect(dates).toHaveCount(3)

  const fill = async (idx: number, date: string, time: string) => {
    await dates.nth(idx).fill(date)
    await dates.nth(idx).blur()
    await times.nth(idx).fill(time)
    await times.nth(idx).blur()
  }
  await fill(0, "2026-05-19", "09:00")
  await fill(1, "2026-05-19", "11:30")
  await fill(2, "2026-05-19", "16:30")

  // The Summary's start/end are derived from those cells, and read-only.
  await page.getByText("Summary", { exact: true }).first().click()
  const start = page.locator('input[type="datetime-local"]').first()
  const end = page.locator('input[type="datetime-local"]').nth(1)

  await expect(start).toHaveValue("2026-05-19T09:00")
  await expect(end).toHaveValue("2026-05-19T16:30")
  await expect(start).toBeDisabled()
  await expect(end).toBeDisabled()
})

test("an end before the last step is rejected: error shown, time cleared", async ({
  page,
}) => {
  await openProcessingTab(page)

  const table = page
    .locator("main table")
    .filter({ hasText: "Processing Times" })
  const row = table.locator("tr", { hasText: "Processing Times" })
  const dates = row.locator('input[type="date"]')
  const times = row.locator('input[type="time"]')

  const fill = async (idx: number, date: string, time: string) => {
    await dates.nth(idx).fill(date)
    await dates.nth(idx).blur()
    await times.nth(idx).fill(time)
    await times.nth(idx).blur()
  }
  await fill(0, "2026-05-19", "09:00")
  await fill(1, "2026-05-19", "11:30")
  // End of experiment *before* the last step began → direct failure: the entry
  // is announced as rejected and the field is cleared so the user retries.
  await fill(2, "2026-05-19", "10:00")

  await expect(page.getByText("Time not accepted").first()).toBeVisible()
  await expect(times.nth(2)).toHaveValue("")
  // The date cascade stays, so only the time buzzes for a retry.
  await expect(dates.nth(2)).toHaveValue("2026-05-19")
})

test("raising an early step above a later one keeps the current time and explains", async ({
  page,
}) => {
  await openProcessingTab(page)

  const table = page
    .locator("main table")
    .filter({ hasText: "Processing Times" })
  const row = table.locator("tr", { hasText: "Processing Times" })
  const dates = row.locator('input[type="date"]')
  const times = row.locator('input[type="time"]')

  const fill = async (idx: number, date: string, time: string) => {
    await dates.nth(idx).fill(date)
    await dates.nth(idx).blur()
    await times.nth(idx).fill(time)
    await times.nth(idx).blur()
  }
  await fill(0, "2026-05-19", "09:00")
  await fill(1, "2026-05-19", "11:30")
  await fill(2, "2026-05-19", "16:30")

  // Dependent failure: step 1 raised past step 2 would invalidate step 2 —
  // the change is refused, the current time stays, and the message explains.
  await times.nth(0).fill("17:00")
  await times.nth(0).blur()

  await expect(page.getByText("Time not accepted").first()).toBeVisible()
  await expect(times.nth(0)).toHaveValue("09:00")
})
