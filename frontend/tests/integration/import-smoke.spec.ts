import path from "node:path"
import { test, expect } from "./fixtures"

test("import ZIP → new process-free experiment → results → reload → download → append", async ({
  authedPage: page,
}) => {
  await page.goto("/")
  await expect(page).not.toHaveURL(/login/, { timeout: 20_000 })

  // Navigate to Experiments via the sidebar.
  await page.getByRole("button", { name: "Experiments" }).click()
  await expect(page).toHaveURL(/experiments/, { timeout: 20_000 })

  // Open Import Data.
  await page.getByRole("button", { name: "Import Data" }).click()
  await expect(page.getByRole("heading", { name: "Import Data" })).toBeVisible({
    timeout: 10_000,
  })

  // Select the ZIP through the dropzone's hidden file input.
  const zip = path.resolve(
    "..",
    "workbench",
    "zip-explorer-fixtures",
    "valid_perovskite.zip",
  )
  await page.locator('.mantine-Dropzone-root input[type="file"]').setInputFiles(zip)

  // Preview appears.
  await expect(page.getByText("Import destination")).toBeVisible({
    timeout: 20_000,
  })

  // Create a NEW experiment (no process).
  await page.getByText("New experiment", { exact: true }).click()
  const name = `Smoke Import ${Date.now()}`
  await page.getByPlaceholder("Imported Experiment").fill(name)
  await page.getByRole("button", { name: "Create & import" }).click()

  // Lands on Results with the imported experiment selected.
  await expect(page).toHaveURL(/results/, { timeout: 30_000 })
  await page.getByText("Original Files", { exact: true }).click()
  await expect(page.getByText("Original files")).toBeVisible({ timeout: 20_000 })

  // The experiment name appears in the breadcrumb/header.
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 })

  // Reload: measurements and original files survive.
  await page.reload()
  await expect(page).not.toHaveURL(/login/, { timeout: 20_000 })
  // Re-select the imported experiment in the Results list (selection is not
  // persisted across reload). The sidebar is collapsed by default; expand it
  // to see experiment names.
  await page.getByRole("button", { name: "Expand sidebar" }).click()
  await page.getByText(name, { exact: true }).first().click()
  await page.getByText("Original Files", { exact: true }).click()
  await expect(page.getByText("Original files")).toBeVisible({ timeout: 20_000 })

  // Retrieve (download) an original file.
  const downloadPromise = page.waitForEvent("download", { timeout: 20_000 })
  await page
    .getByRole("button", { name: /Download/ })
    .first()
    .click()
  const download = await downloadPromise
  expect(download.suggestedFilename().length).toBeGreaterThan(0)

  // Append additional measurements to the SAME experiment.
  await page.getByRole("button", { name: "Experiments" }).click()
  await expect(page).toHaveURL(/experiments/, { timeout: 20_000 })
  await page.getByRole("button", { name: "Import Data" }).click()
  await page.locator('.mantine-Dropzone-root input[type="file"]').setInputFiles(zip)
  await expect(page.getByText("Import destination")).toBeVisible({
    timeout: 20_000,
  })
  // Existing experiment mode is the default; select the one just created.
  await page.getByText("Existing experiment", { exact: true }).click()
  await page.getByPlaceholder("Choose an experiment…").click()
  await page.getByRole("option", { name }).click()
  await page.getByRole("button", { name: "Import measurements" }).click()
  // Re-importing the same fixture triggers the duplicate-confirmation dialog.
  await page.getByRole("button", { name: "Append anyway" }).click()

  // Returns to Results; the appended records are local-only (not uploaded).
  await expect(page).toHaveURL(/results/, { timeout: 30_000 })
  await page.getByText("NOMAD Preparation", { exact: true }).click()
  await expect(page.getByText(/local-only \(not uploaded\)/)).toBeVisible({
    timeout: 20_000,
  })
})
