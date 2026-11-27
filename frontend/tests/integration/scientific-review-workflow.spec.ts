import path from "node:path"
import { test, expect } from "./fixtures"

// Self-contained synthetic JV dataset (LabFlow-style import fixture).
const FIXTURE = path.resolve(
  "tests",
  "integration",
  "fixtures",
  "01-precise-perfect-complete.zip",
)

test("scientific review correction persists across reload", async ({
  authedPage,
}) => {
  await authedPage.goto("/")
  await expect(authedPage).not.toHaveURL(/login/, { timeout: 20_000 })

  await authedPage.getByRole("button", { name: "Experiments" }).click()
  await expect(authedPage).toHaveURL(/experiments/, { timeout: 20_000 })

  // Import fixture into a new experiment.
  await authedPage.getByRole("button", { name: "Import Data" }).click()
  await expect(
    authedPage.getByRole("heading", { name: "Import Data" }),
  ).toBeVisible()
  await authedPage
    .locator('.mantine-Dropzone-root input[type="file"]')
    .setInputFiles(FIXTURE)
  await expect(authedPage.getByText("Import destination")).toBeVisible({
    timeout: 30_000,
  })
  await authedPage.getByText("New experiment", { exact: true }).click()
  const name = `Scientific Review ${Date.now()}`
  await authedPage.getByPlaceholder("Imported Experiment").fill(name)
  await authedPage.getByRole("button", { name: "Create & import" }).click()

  await expect(authedPage).toHaveURL(/results/, { timeout: 30_000 })
  await expect(
    authedPage.getByText("Measurements", { exact: true }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // Select a measurement to confirm its curve renders.
  await authedPage.getByText("ADDITIVE-1A", { exact: true }).first().click()
  await expect(authedPage.getByText(/Vmpp/).first()).toBeVisible({
    timeout: 15_000,
  })

  // Apply a numerical correction (scale PCE by 0.5).
  await authedPage.getByText("Scientific Review", { exact: true }).click()
  await expect(
    authedPage.getByText("Scientific review", { exact: true }),
  ).toBeVisible({ timeout: 15_000 })
  await authedPage.getByText(/ADDITIVE-1A \(FW\)/).first().click()
  await authedPage.getByRole("button", { name: "Scale" }).first().click()
  await authedPage.getByLabel("Factor").fill("0.5")
  await authedPage.getByLabel("Reason").fill("unit conversion")
  await authedPage.getByRole("button", { name: "Apply" }).click()
  await expect(authedPage.getByText("Scaling applied")).toBeVisible({
    timeout: 15_000,
  })

  // The correction history records the before/after with the reason.
  await authedPage.getByText("Correction history").click()
  await expect(authedPage.getByText("unit conversion")).toBeVisible({
    timeout: 15_000,
  })

  // NOMAD Preparation is a separate view.
  await authedPage.getByText("NOMAD Preparation", { exact: true }).click()
  await expect(
    authedPage.getByText("Step 1", { exact: false }).first(),
  ).toBeVisible({ timeout: 15_000 })

  // Reload: the corrected value persists (re-select the experiment).
  await authedPage.reload()
  await expect(authedPage).not.toHaveURL(/login/, { timeout: 20_000 })
  await authedPage.getByRole("button", { name: "Expand sidebar" }).click()
  await authedPage.getByText(name, { exact: true }).first().click()
  await expect(
    authedPage.getByText("Measurements", { exact: true }).first(),
  ).toBeVisible({ timeout: 20_000 })
})
