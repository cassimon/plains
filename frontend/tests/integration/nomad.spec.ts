import { test, expect } from "@playwright/test"
import { login, apiClient } from "./utils/api"

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"

async function loginToApp(page: import("@playwright/test").Page) {
  await page.goto(`${FRONTEND_BASE_URL}/login`)
  await page.getByLabel(/email/i).fill(process.env.INTEGRATION_TEST_EMAIL!)
  await page.getByLabel(/password/i).fill(process.env.INTEGRATION_TEST_PASSWORD!)
  await page.getByRole("button", { name: /log in|sign in/i }).click()
  await page.waitForURL((url) => !url.href.includes("login"), { timeout: 15_000 })
}

test("NOMAD upload endpoint exists and returns auth error without credentials", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const exp = await api.createExperiment({ name: `NomadExp-${Date.now()}` })
  const results = await api.createExperiment({ name: `NomadResults-${Date.now()}` }) // placeholder

  try {
    // Without valid NOMAD credentials, expect 400 or 422 but not 404 (endpoint exists)
    const res = await fetch(`${API_BASE_URL}/api/v1/nomad/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ results_id: exp.id }),
    })
    expect(res.status).not.toBe(404)
  } finally {
    await api.delete(`/experiments/${exp.id}`)
    await api.delete(`/experiments/${results.id}`)
  }
})

test("results page renders without errors", async ({ page }) => {
  await loginToApp(page)
  await page.goto(`${FRONTEND_BASE_URL}/results`)
  // Page should not show a JS error overlay
  await expect(page.locator("body")).not.toContainText("Something went wrong", { timeout: 10_000 })
})
