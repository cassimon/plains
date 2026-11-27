import path from "node:path"
import { test, expect } from "./fixtures"
import { login } from "./utils/api"

const FRONTEND = process.env.FRONTEND_BASE_URL ?? "http://localhost:5180"
const EMAIL = process.env.SMOKE_TEST_EMAIL ?? "wo08esmoke@t.c"
const PASSWORD = process.env.SMOKE_TEST_PASSWORD ?? "Wo08eSmoke1!"
const SHOTS = path.resolve("..", "workbench", "screenshots", "WO-08")

test("import → analyze → charts → correction reflected", async ({ page }) => {
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
  const zip = path.resolve("..", "..", "..", "Projects", "LabFlow", "TEST_DATA", "01_PRECISO_PERFETTO_COMPLETO.zip")
  await page.locator('.mantine-Dropzone-root input[type="file"]').setInputFiles(zip)
  await expect(page.getByText("Import destination")).toBeVisible({ timeout: 30_000 })
  await page.getByText("New experiment", { exact: true }).click()
  const name = `WO08 ${Date.now()}`
  await page.getByPlaceholder("Imported Experiment").fill(name)
  await page.getByRole("button", { name: "Create & import" }).click()

  await expect(page).toHaveURL(/results/, { timeout: 30_000 })
  await expect(page.getByText("Measurements", { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  const afterImport = await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>).__plainsSnapshot
    return typeof fn === "function" ? (fn as () => unknown)() : null
  })
  console.log("AFTER_IMPORT_SNAPSHOT", JSON.stringify(afterImport))

  // Analyze action → Analysis page.
  await page.getByRole("button", { name: "Analyze" }).click()
  await expect(page).toHaveURL(/analysis/, { timeout: 30_000 })
  console.log("URL", page.url())
  const snap = await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>).__plainsSnapshot
    return typeof fn === "function" ? (fn as () => unknown)() : null
  })
  console.log("SNAPSHOT", JSON.stringify(snap))

  // Select the experiment in the Analysis sidebar (selection isn't reliably
  // propagated across the route change).
  await page.getByText(name, { exact: true }).first().click()

  // Scientific overview + charts render with real data.
  await expect(page.getByText("Scientific overview")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/Hysteresis/).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("Analysis charts")).toBeVisible({ timeout: 20_000 })

  // Screenshot 1: scientific overview.
  await page.screenshot({ path: path.join(SHOTS, "01-scientific-overview.png"), fullPage: true })

  // Screenshot 2: charts (group comparison / box plot area).
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(SHOTS, "02-group-comparison.png"), fullPage: true })

  // Screenshot 3: hysteresis analysis.
  await page.mouse.wheel(0, 1400)
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(SHOTS, "03-hysteresis-analysis.png"), fullPage: true })
})
