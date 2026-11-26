import path from "node:path"
import { test, expect } from "./fixtures"
import { login } from "./utils/api"

const FRONTEND = process.env.FRONTEND_BASE_URL ?? "http://localhost:5175"
const EMAIL = process.env.SMOKE_TEST_EMAIL ?? "wo06smoke@test.plains"
const PASSWORD = process.env.SMOKE_TEST_PASSWORD ?? "Wo06Smoke1!"
const SHOTS = path.resolve("..", "workbench", "screenshots", "WO-06")

test("import LabFlow JV ZIP → measurements, curve, correction", async ({ page }) => {
  const token = await login(EMAIL, PASSWORD)
  await page.addInitScript(
    ([k, v]) => window.localStorage.setItem(k, v),
    ["__plains_test_token", token] as const,
  )

  await page.goto(FRONTEND)
  await expect(page).not.toHaveURL(/login/, { timeout: 20_000 })
  await page.getByRole("button", { name: "Experiments" }).click()
  await expect(page).toHaveURL(/experiments/, { timeout: 20_000 })

  await page.getByRole("button", { name: "Import Data" }).click()
  await expect(page.getByRole("heading", { name: "Import Data" })).toBeVisible()

  const zip = path.resolve(
    "..",
    "..",
    "..",
    "Projects",
    "LabFlow",
    "TEST_DATA",
    "01_PRECISO_PERFETTO_COMPLETO.zip",
  )
  await page.locator('.mantine-Dropzone-root input[type="file"]').setInputFiles(zip)
  await expect(page.getByText("Import destination")).toBeVisible({ timeout: 30_000 })

  await page.getByText("New experiment", { exact: true }).click()
  const name = `WO06 LabFlow ${Date.now()}`
  await page.getByPlaceholder("Imported Experiment").fill(name)
  await page.getByRole("button", { name: "Create & import" }).click()

  await expect(page).toHaveURL(/results/, { timeout: 30_000 })
  await expect(page.getByText("Measurements")).toBeVisible({ timeout: 20_000 })

  // Screenshot 1: Results immediately after import.
  await page.screenshot({ path: path.join(SHOTS, "01-results-after-import.png"), fullPage: true })

  // Select a measurement with a curve (ADDITIVE-1A FW row).
  await page.getByText("ADDITIVE-1A", { exact: true }).first().click()
  await expect(page.getByText(/Vmpp/).first()).toBeVisible({ timeout: 15_000 })

  // Screenshot 2: selected measurement with its JV curve.
  await page.screenshot({ path: path.join(SHOTS, "02-measurement-curve.png"), fullPage: true })

  // Open scientific review and exclude a measurement.
  await page.getByText("Scientific review").scrollIntoViewIfNeeded()
  await expect(page.getByText("Scientific review")).toBeVisible()
  await page.screenshot({ path: path.join(SHOTS, "03-review-corrections.png"), fullPage: true })
})
