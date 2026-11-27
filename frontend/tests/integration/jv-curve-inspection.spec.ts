import path from "node:path"
import { test, expect } from "./fixtures"

// Self-contained synthetic JV dataset (LabFlow-style import fixture).
const FIXTURE = path.resolve(
  "tests",
  "integration",
  "fixtures",
  "01-precise-perfect-complete.zip",
)

test("import a JV dataset and inspect a measurement curve", async ({
  authedPage,
}) => {
  await authedPage.goto("/")
  await expect(authedPage).not.toHaveURL(/login/, { timeout: 20_000 })
  await authedPage.getByRole("button", { name: "Experiments" }).click()
  await expect(authedPage).toHaveURL(/experiments/, { timeout: 20_000 })

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
  const name = `JV Curve ${Date.now()}`
  await authedPage.getByPlaceholder("Imported Experiment").fill(name)
  await authedPage.getByRole("button", { name: "Create & import" }).click()

  await expect(authedPage).toHaveURL(/results/, { timeout: 30_000 })
  await expect(
    authedPage.getByText("Measurements", { exact: true }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // Selecting a measurement with a captured curve shows the JV chart.
  await authedPage.getByText("ADDITIVE-1A", { exact: true }).first().click()
  await expect(authedPage.getByText(/Vmpp/).first()).toBeVisible({
    timeout: 15_000,
  })

  // Every measurement is reviewable, curve or not.
  await authedPage.getByText("Scientific review").scrollIntoViewIfNeeded()
  await expect(authedPage.getByText("Scientific review")).toBeVisible()
})
