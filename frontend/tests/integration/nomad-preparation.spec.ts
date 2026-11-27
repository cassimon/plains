import path from "node:path"
import { test, expect } from "./fixtures"

// Self-contained synthetic JV dataset (LabFlow-style import fixture).
const FIXTURE = path.resolve(
  "tests",
  "integration",
  "fixtures",
  "01-precise-perfect-complete.zip",
)

test("NOMAD preparation excludes excluded and local-only measurements", async ({
  authedPage,
}) => {
  await authedPage.goto("/")
  await expect(authedPage).not.toHaveURL(/login/, { timeout: 20_000 })
  await authedPage.getByRole("button", { name: "Experiments" }).click()
  await expect(authedPage).toHaveURL(/experiments/, { timeout: 20_000 })

  // Import fixture into a new (process-free) experiment. Imported measurements
  // are durable and local-only (not yet uploaded).
  await authedPage.getByRole("button", { name: "Import Data" }).click()
  await authedPage
    .locator('.mantine-Dropzone-root input[type="file"]')
    .setInputFiles(FIXTURE)
  await expect(authedPage.getByText("Import destination")).toBeVisible({
    timeout: 30_000,
  })
  await authedPage.getByText("New experiment", { exact: true }).click()
  const name = `NOMAD Preparation ${Date.now()}`
  await authedPage.getByPlaceholder("Imported Experiment").fill(name)
  await authedPage.getByRole("button", { name: "Create & import" }).click()

  await expect(authedPage).toHaveURL(/results/, { timeout: 30_000 })
  await expect(
    authedPage.getByText("Measurements", { exact: true }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // NOMAD Preparation: imported measurements are local-only, and the badge
  // reflects that they are not uploaded.
  await authedPage.getByText("NOMAD Preparation", { exact: true }).click()
  await expect(
    authedPage.getByText(/local-only \(not uploaded\)/).first(),
  ).toBeVisible({ timeout: 20_000 })

  // Exclude one observation via Scientific Review.
  await authedPage.getByText("Scientific Review", { exact: true }).click()
  await expect(
    authedPage.getByText("Scientific review", { exact: true }),
  ).toBeVisible({ timeout: 15_000 })
  await authedPage.getByText(/ADDITIVE-1A \(FW\)/).first().click()
  await authedPage.getByRole("button", { name: "Exclude", exact: true }).first().click()
  await authedPage.getByLabel("Reason").fill("outlier")
  await authedPage
    .locator(".mantine-Modal-root")
    .getByRole("button", { name: "Exclude", exact: true })
    .click()
  await expect(authedPage.getByText("Measurement excluded")).toBeVisible({
    timeout: 15_000,
  })

  // Back to NOMAD Preparation: the excluded badge now appears too.
  await authedPage.getByText("NOMAD Preparation", { exact: true }).click()
  await expect(
    authedPage.getByText(/excluded \(not uploaded\)/).first(),
  ).toBeVisible({ timeout: 20_000 })
})
