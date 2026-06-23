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

test("create process via UI and verify in API", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const name = `UI-Process-${Date.now()}`

  await loginToApp(page)
  await page.goto(`${FRONTEND_BASE_URL}/processes`)
  await page.getByRole("button", { name: /add|create|new process/i }).first().click()
  await page.getByLabel(/name/i).fill(name)
  await page.getByRole("button", { name: /save|create|submit/i }).click()

  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })

  const res = await fetch(`${API_BASE_URL}/api/v1/processes/?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  const found = data.data.find((p: { name: string }) => p.name === name)
  expect(found).toBeDefined()
  if (found) await api.delete(`/processes/${found.id}`)
})

test("seeded process appears in the list", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const name = `Seeded-Process-${Date.now()}`
  const proc = await api.createProcess({ name })

  try {
    await loginToApp(page)
    await page.goto(`${FRONTEND_BASE_URL}/processes`)
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })
  } finally {
    await api.delete(`/processes/${proc.id}`)
  }
})

test("cascade delete removes process steps", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const proc = await api.createProcess({ name: `CascadeProc-${Date.now()}` })

  // Add a step
  const stepRes = await fetch(`${API_BASE_URL}/api/v1/processes/${proc.id}/steps/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      stage_index: 0,
      step_index: 0,
      name: "Test Step",
      step_category: "wet_deposition",
      color: "#000000",
    }),
  })
  expect(stepRes.ok).toBe(true)

  await api.delete(`/processes/${proc.id}`)
  const check = await fetch(`${API_BASE_URL}/api/v1/processes/${proc.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(check.status).toBe(404)
})

test("IDOR: other user cannot access process", async () => {
  const superToken = process.env.INTEGRATION_TOKEN!
  const userToken = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const superApi = apiClient(superToken)
  const proc = await superApi.createProcess({ name: `IDOR-Proc-${Date.now()}` })

  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/processes/${proc.id}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect([403, 404]).toContain(res.status)
  } finally {
    await superApi.delete(`/processes/${proc.id}`)
  }
})
