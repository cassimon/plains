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

test("seeded materials appear in the list", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const suffix = Date.now()
  const m1 = await api.createMaterial({ name: `Material-A-${suffix}`, category: "chemical_compound" })
  const m2 = await api.createMaterial({ name: `Material-B-${suffix}`, category: "substrate" })

  try {
    await loginToApp(page)
    await page.goto(`${FRONTEND_BASE_URL}/materials`)
    await expect(page.getByText(`Material-A-${suffix}`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(`Material-B-${suffix}`)).toBeVisible()
  } finally {
    await api.delete(`/materials/${m1.id}`)
    await api.delete(`/materials/${m2.id}`)
  }
})

test("create material via UI and verify in API", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const name = `UI-Material-${Date.now()}`

  await loginToApp(page)
  await page.goto(`${FRONTEND_BASE_URL}/materials`)
  await page.getByRole("button", { name: /add|create|new material/i }).first().click()
  await page.getByLabel(/name/i).fill(name)
  await page.getByRole("button", { name: /save|create|submit/i }).click()

  // Verify in UI
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })

  // Verify in API
  const res = await fetch(`${API_BASE_URL}/api/v1/materials/?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  const found = data.data.find((m: { name: string }) => m.name === name)
  expect(found).toBeDefined()
  if (found) await api.delete(`/materials/${found.id}`)
})

test("delete material via UI is reflected in API", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const name = `ToDelete-${Date.now()}`
  const mat = await api.createMaterial({ name, category: "chemical_compound" })

  await loginToApp(page)
  await page.goto(`${FRONTEND_BASE_URL}/materials`)
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })
  await page.getByText(name).click()
  await page.getByRole("button", { name: /delete/i }).click()
  await page.getByRole("button", { name: /confirm|yes/i }).click()
  await expect(page.getByText(name)).not.toBeVisible({ timeout: 10_000 })

  const res = await fetch(`${API_BASE_URL}/api/v1/materials/${mat.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(404)
})
