import path from "node:path"
import { test, expect } from "./fixtures"
import { login } from "./utils/api"

const FRONTEND = process.env.FRONTEND_BASE_URL ?? "http://localhost:5177"
const EMAIL = process.env.SMOKE_TEST_EMAIL ?? "wo07smoke@t.c"
const PASSWORD = process.env.SMOKE_TEST_PASSWORD ?? "Wo07Smoke1!"
const SHOTS = path.resolve("..", "workbench", "screenshots", "WO-07")

test("four views + correction + reload", async ({ page }) => {
  const token = await login(EMAIL, PASSWORD)
  await page.addInitScript(
    ([k, v]) => window.localStorage.setItem(k, v),
    ["__plains_test_token", token] as const,
  )

  await page.goto(FRONTEND)
  await expect(page).not.toHaveURL(/login/, { timeout: 20_000 })

  // Screenshot 1: Experiments entry view.
  await page.getByRole("button", { name: "Experiments" }).click()
  await expect(page).toHaveURL(/experiments/, { timeout: 20_000 })
  await page.screenshot({ path: path.join(SHOTS, "01-experiments-entry.png"), fullPage: true })

  // Import fixture 01 into a new experiment.
  await page.getByRole("button", { name: "Import Data" }).click()
  await expect(page.getByRole("heading", { name: "Import Data" })).toBeVisible()
  const zip = path.resolve("..", "..", "..", "Projects", "LabFlow", "TEST_DATA", "01_PRECISO_PERFETTO_COMPLETO.zip")
  await page.locator('.mantine-Dropzone-root input[type="file"]').setInputFiles(zip)
  await expect(page.getByText("Import destination")).toBeVisible({ timeout: 30_000 })
  await page.getByText("New experiment", { exact: true }).click()
  const name = `WO07 ${Date.now()}`
  await page.getByPlaceholder("Imported Experiment").fill(name)
  await page.getByRole("button", { name: "Create & import" }).click()

  // Results → Measurements is the default view.
  await expect(page).toHaveURL(/results/, { timeout: 30_000 })
  await expect(page.getByText("Measurements", { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: path.join(SHOTS, "02-results-after-import.png"), fullPage: true })

  // Select a measurement → full chart.
  await page.getByText("ADDITIVE-1A", { exact: true }).first().click()
  await expect(page.getByText(/Vmpp/).first()).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: path.join(SHOTS, "03-measurement-chart.png"), fullPage: true })

  // Scientific Review: apply a numerical correction (scale PCE by 0.5).
  await page.getByText("Scientific Review", { exact: true }).click()
  await expect(page.getByText("Scientific review", { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await page.getByText(/ADDITIVE-1A \(FW\)/).first().click()
  await page.getByRole("button", { name: "Scale" }).first().click()
  await page.getByLabel("Factor").fill("0.5")
  await page.getByLabel("Reason").fill("unit conversion")
  await page.getByRole("button", { name: "Apply" }).click()
  await expect(page.getByText("Scaling applied")).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: path.join(SHOTS, "04-scientific-review-correction.png"), fullPage: true })

  // Correction history shows the before/after.
  await page.getByText("Correction history").click()
  await expect(page.getByText("unit conversion")).toBeVisible({ timeout: 15_000 })

  // NOMAD Preparation is a separate view.
  await page.getByText("NOMAD Preparation", { exact: true }).click()
  await expect(page.getByText("Step 1", { exact: false }).first()).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: path.join(SHOTS, "05-nomad-preparation.png"), fullPage: true })

  // Reload: the corrected value persists (re-select the experiment).
  await page.reload()
  await expect(page).not.toHaveURL(/login/, { timeout: 20_000 })
  await page.getByRole("button", { name: "Expand sidebar" }).click()
  await page.getByText(name, { exact: true }).first().click()
  await expect(page.getByText("Measurements", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
})
