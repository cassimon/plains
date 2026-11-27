import path from "node:path"
import { test, expect } from "./fixtures"

// Self-contained synthetic JV dataset (LabFlow-style import fixture).
const FIXTURE = path.resolve(
  "tests",
  "integration",
  "fixtures",
  "01-precise-perfect-complete.zip",
)

test("import → analyze → charts render with real data", async ({ authedPage }) => {
  await authedPage.goto("/")
  await expect(authedPage).not.toHaveURL(/login/, { timeout: 20_000 })
  await authedPage.getByRole("button", { name: "Experiments" }).click()
  await expect(authedPage).toHaveURL(/experiments/, { timeout: 20_000 })

  await authedPage.getByRole("button", { name: "Import Data" }).click()
  await authedPage
    .locator('.mantine-Dropzone-root input[type="file"]')
    .setInputFiles(FIXTURE)
  await expect(authedPage.getByText("Import destination")).toBeVisible({
    timeout: 30_000,
  })
  await authedPage.getByText("New experiment", { exact: true }).click()
  const name = `Scientific Analysis ${Date.now()}`
  await authedPage.getByPlaceholder("Imported Experiment").fill(name)
  await authedPage.getByRole("button", { name: "Create & import" }).click()

  await expect(authedPage).toHaveURL(/results/, { timeout: 30_000 })
  await expect(
    authedPage.getByText("Measurements", { exact: true }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // Analyze action → Analysis page.
  await authedPage.getByRole("button", { name: "Analyze" }).click()
  await expect(authedPage).toHaveURL(/analysis/, { timeout: 30_000 })

  // Select the experiment in the Analysis sidebar (selection isn't reliably
  // propagated across the route change).
  await authedPage.getByText(name, { exact: true }).first().click()

  // Scientific overview + charts render with real data.
  await expect(authedPage.getByText("Scientific overview")).toBeVisible({
    timeout: 20_000,
  })
  await expect(authedPage.getByText(/Hysteresis/).first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(authedPage.getByText("Analysis charts")).toBeVisible({
    timeout: 20_000,
  })
})
