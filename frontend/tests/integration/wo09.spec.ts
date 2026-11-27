import path from "node:path"
import { test, expect } from "./fixtures"
import { login } from "./utils/api"

const FRONTEND = process.env.FRONTEND_BASE_URL ?? "http://localhost:5180"
const EMAIL = process.env.SMOKE_TEST_EMAIL ?? "wo09smoke@t.c"
const PASSWORD = process.env.SMOKE_TEST_PASSWORD ?? "Wo09Smoke1!"
const SHOTS = path.resolve("..", "workbench", "screenshots", "WO-09")

test("NOMAD prep excludes excluded/local-only measurements", async ({ page }) => {
  const token = await login(EMAIL, PASSWORD)
  await page.addInitScript(
    ([k, v]) => window.localStorage.setItem(k, v),
    ["__plains_test_token", token] as const,
  )

  await page.goto(FRONTEND)
  await expect(page).not.toHaveURL(/login/, { timeout: 20_000 })
  await page.getByRole("button", { name: "Experiments" }).click()
  await expect(page).toHaveURL(/experiments/, { timeout: 20_000 })

  // Import fixture 01 into a new (process-free) experiment. Imported
  // measurements are durable + local-only, not NOMAD-bound.
  await page.getByRole("button", { name: "Import Data" }).click()
  const zip = path.resolve(
    "..",
    "..",
    "..",
    "Projects",
    "LabFlow",
    "TEST_DATA",
    "01_PRECISO_PERFETTO_COMPLETO.zip",
  )
  await page
    .locator('.mantine-Dropzone-root input[type="file"]')
    .setInputFiles(zip)
  await expect(page.getByText("Import destination")).toBeVisible({ timeout: 30_000 })
  await page.getByText("New experiment", { exact: true }).click()
  const name = `WO09 ${Date.now()}`
  await page.getByPlaceholder("Imported Experiment").fill(name)
  await page.getByRole("button", { name: "Create & import" }).click()

  await expect(page).toHaveURL(/results/, { timeout: 30_000 })
  await expect(page.getByText("Measurements", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })

  // NOMAD Preparation tab: imported measurements are local-only, and the
  // badge must reflect that they are not uploaded.
  await page.getByText("NOMAD Preparation", { exact: true }).click()
  await expect(
    page.getByText(/local-only \(not uploaded\)/).first(),
  ).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: path.join(SHOTS, "01-nomad-local-only.png"), fullPage: true })

  // Exclude one observation via Scientific Review.
  await page.getByText("Scientific Review", { exact: true }).click()
  await expect(page.getByText("Scientific review", { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await page.getByText(/ADDITIVE-1A \(FW\)/).first().click()
  await page.getByRole("button", { name: "Exclude", exact: true }).first().click()
  await page.getByLabel("Reason").fill("outlier")
  await page
    .locator(".mantine-Modal-root")
    .getByRole("button", { name: "Exclude", exact: true })
    .click()
  await expect(page.getByText("Measurement excluded")).toBeVisible({ timeout: 15_000 })

  // Back to NOMAD Preparation: the excluded badge now appears too.
  await page.getByText("NOMAD Preparation", { exact: true }).click()
  await expect(
    page.getByText(/excluded \(not uploaded\)/).first(),
  ).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: path.join(SHOTS, "02-nomad-excluded.png"), fullPage: true })
})
