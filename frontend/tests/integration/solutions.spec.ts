import { test, expect } from "@playwright/test"
import { login, apiClient } from "./utils/api"

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

async function loginToApp(page: import("@playwright/test").Page) {
  await page.goto(`${FRONTEND_BASE_URL}/login`)
  await page.getByLabel(/email/i).fill(process.env.INTEGRATION_TEST_EMAIL!)
  await page.getByLabel(/password/i).fill(process.env.INTEGRATION_TEST_PASSWORD!)
  await page.getByRole("button", { name: /log in|sign in/i }).click()
  await page.waitForURL((url) => !url.href.includes("login"), { timeout: 15_000 })
}

test("seeded solutions appear in the list", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const suffix = Date.now()
  const s1 = await api.createSolution({ name: `Solution-A-${suffix}` })
  const s2 = await api.createSolution({ name: `Solution-B-${suffix}` })

  try {
    await loginToApp(page)
    await page.goto(`${FRONTEND_BASE_URL}/solutions`)
    await expect(page.getByText(`Solution-A-${suffix}`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(`Solution-B-${suffix}`)).toBeVisible()
  } finally {
    await api.delete(`/solutions/${s1.id}`)
    await api.delete(`/solutions/${s2.id}`)
  }
})

test("create solution via UI and verify in API", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const name = `UI-Solution-${Date.now()}`

  await loginToApp(page)
  await page.goto(`${FRONTEND_BASE_URL}/solutions`)
  await page.getByRole("button", { name: /add|create|new solution/i }).first().click()
  await page.getByLabel(/name/i).fill(name)
  await page.getByRole("button", { name: /save|create|submit/i }).click()

  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })

  const res = await fetch(`${API_BASE_URL}/api/v1/solutions/?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  const found = data.data.find((s: { name: string }) => s.name === name)
  expect(found).toBeDefined()
  if (found) await api.delete(`/solutions/${found.id}`)
})

test("cascade delete removes solution components", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const mat = await api.createMaterial({ name: `SolComp-Mat-${Date.now()}`, category: "chemical_compound" })
  const sol = await api.createSolution({ name: `SolComp-Sol-${Date.now()}` })

  // Add a component
  await fetch(`${API_BASE_URL}/api/v1/solutions/${sol.id}/components/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ material_id: mat.id, amount: 10, unit: "mg" }),
  })

  // Delete solution and verify 404
  await api.delete(`/solutions/${sol.id}`)
  const check = await fetch(`${API_BASE_URL}/api/v1/solutions/${sol.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(check.status).toBe(404)
  await api.delete(`/materials/${mat.id}`)
})
